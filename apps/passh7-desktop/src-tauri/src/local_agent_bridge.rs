//! Minimal local-CLI adapter. No remote daemon, cloud API or persisted token.
//! Local coding CLIs use this executable in stdio MCP mode. Its authenticated
//! loopback link calls the SAME live SSH/SFTP session manager as the desktop UI.
use std::{
    collections::HashMap, fs::{self,OpenOptions},io::{BufRead,Read,Write},
    net::{Ipv4Addr,SocketAddr,SocketAddrV4,TcpStream},
    path::{Path,PathBuf},process::{Command,Stdio},
    sync::{Arc,Mutex},time::{Duration,Instant}
};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use tauri::{Manager,State};
use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener,sync::Mutex as AsyncMutex};
use crate::{SessionStore,ssh_sessions::SshSessionManager};

const MAX_RPC:usize=2*1024*1024;
const GRANT_MAX_AGE:Duration=Duration::from_secs(12*3600);
type Grants=Arc<Mutex<HashMap<String,Grant>>>;
struct Grant{id:String,agent:String,session:String,created:Instant}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct LocalAgentConnection{
    id:String,agent:String,session_id:String,host:String,age_seconds:u64,
}
fn revoke_grant_by_id(grants:&Grants,id:&str)->Result<bool,String>{
    let mut guard=grants.lock().map_err(|_|"Local CLI grants unavailable")?;
    let Some(token)=guard.iter().find_map(|(token,grant)|
        (grant.id==id).then(||token.clone())) else{return Ok(false)};
    guard.remove(&token);
    Ok(true)
}

#[derive(Default)]
pub struct LocalAgentBridge{
    address:AsyncMutex<Option<SocketAddr>>,
    grants:Grants,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct LocalAgentStatus{pub installed:bool,pub path:Option<String>,pub diagnostic:String}

fn allowed_agent(agent:&str)->Result<&'static str,String>{
    match agent{"codex"=>Ok("codex"),"claude"=>Ok("claude"),"opencode"=>Ok("opencode"),
        _=>Err("Unsupported local coding CLI".into())}
}
fn local_cli_candidates(agent:&str)->Vec<PathBuf>{
    let mut dirs=Vec::new();
    if let Some(path)=std::env::var_os("PATH"){dirs.extend(std::env::split_paths(&path));}
    if cfg!(windows){
        if let Some(v)=std::env::var_os("APPDATA"){dirs.push(PathBuf::from(v).join("npm"));}
        if let Some(v)=std::env::var_os("LOCALAPPDATA"){
            let home=PathBuf::from(v);
            dirs.push(home.join("pnpm"));
            dirs.push(home.join("Yarn").join("bin"));
            dirs.push(home.join("Microsoft").join("WinGet").join("Links"));
        }
        if let Some(v)=std::env::var_os("USERPROFILE"){
            let home=PathBuf::from(v);
            for suffix in [".local/bin",".cargo/bin",".bun/bin",".volta/bin","scoop/shims"]{
                dirs.push(home.join(suffix));
            }
        }
        if let Some(v)=std::env::var_os("PNPM_HOME"){dirs.push(PathBuf::from(v));}
    }
    let names:Vec<String>=if cfg!(windows){
        ["cmd","exe","ps1","bat"].iter().map(|x|format!("{agent}.{x}")).collect()
    }else{vec![agent.to_owned()]};
    dirs.into_iter().filter(|dir|!dir.to_string_lossy().to_ascii_lowercase().contains("windowsapps"))
        .flat_map(|dir|names.iter().map(|name|dir.join(name)).collect::<Vec<_>>())
        .filter(|path|path.is_file()).collect()
}
fn ps_quote(text:&str)->String{format!("'{}'",text.replace('\'',"''"))}
fn verify_local_cli(path:&Path)->bool{
    // Do not launch an unknown shell command from the UI. Validate the absolute
    // candidate and execute --version with a bounded wait.
    let mut cmd=if cfg!(windows){
        let mut c=Command::new("powershell.exe");
        let script=format!("& {} --version",ps_quote(&path.to_string_lossy()));
        c.args(["-NoProfile","-NonInteractive","-Command",&script]);c
    }else{
        let mut c=Command::new(path);c.arg("--version");c
    };
    let Ok(mut child)=cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else{return false};
    let started=Instant::now();
    loop{
        match child.try_wait(){
            Ok(Some(status))=>return status.success(),
            Err(_)=>return false,
            Ok(None) if started.elapsed()>=Duration::from_secs(5)=>{
                let _=child.kill();let _=child.wait();return false;
            },
            _=>std::thread::sleep(Duration::from_millis(40))
        }
    }
}
fn discover_local_cli(agent:&str)->Result<PathBuf,String>{
    let binary=allowed_agent(agent)?;
    local_cli_candidates(binary).into_iter().find(|path|verify_local_cli(path))
        .ok_or_else(||format!("{binary} CLI not found or --version failed for the local Windows/Linux user. Sign in using its normal CLI before launch."))
}
#[tauri::command]
pub async fn local_agent_probe(agent:String)->Result<LocalAgentStatus,String>{
    let path=tokio::task::spawn_blocking(move||discover_local_cli(&agent)).await
        .map_err(|_|"Local CLI discovery interrupted".to_owned())?;
    Ok(match path{
        Ok(path)=>LocalAgentStatus{installed:true,path:Some(path.to_string_lossy().into_owned()),
            diagnostic:"Local CLI executable verified with --version. Login/authentication is managed by the CLI itself.".into()},
        Err(diagnostic)=>LocalAgentStatus{installed:false,path:None,diagnostic}
    })
}

#[derive(Deserialize)]
struct BrokerRequest{token:String,op:String,command:Option<String>,path:Option<String>,content:Option<String>}
async fn serve_connection(mut socket:tokio::net::TcpStream,grants:Grants,ssh:SshSessionManager,app:tauri::AppHandle){
    let result=async{
        let len=socket.read_u32().await.map_err(|_|"Invalid local bridge frame".to_owned())? as usize;
        if len==0||len>MAX_RPC{return Err("Local bridge frame too large".into());}
        let mut bytes=vec![0u8;len];
        socket.read_exact(&mut bytes).await.map_err(|_|"Incomplete bridge frame".to_owned())?;
        let req:BrokerRequest=serde_json::from_slice(&bytes)
            .map_err(|_|"Invalid local bridge request".to_owned())?;
        let session={
            let guard=grants.lock().map_err(|_|"Local bridge unavailable".to_owned())?;
            let grant=guard.get(&req.token).ok_or("Local agent grant is revoked")?;
            if grant.created.elapsed()>GRANT_MAX_AGE{return Err("Local agent grant expired".into());}
            grant.session.clone()
        };
        // A CLI can stay open for hours. An existing grant must not bypass
        // the Vault's idle lock just because UI polling has not noticed expiry.
        // Crucially, this check never refreshes the local activity timer.
        if !app.state::<SessionStore>().live_without_touch()?{
            ssh.stop_all();
            return Err("Vault locked or expired; unlock it and start a new local agent session".into());
        }
        let result=match req.op.as_str(){
            "exec"=>{
                let command=req.command.ok_or("Missing remote command")?;
                serde_json::to_value(ssh.execute_remote(&session,&command).await?)
                    .map_err(|_|"Cannot encode SSH exec output".to_owned())?
            },
            "list"=>{
                let items=ssh.remote_list(&session,&req.path.ok_or("Missing remote directory")?).await?;
                serde_json::to_value(items).map_err(|_|"Cannot encode SFTP directory listing".to_owned())?
            },
            "read"=>json!(ssh.remote_read(&session,&req.path.ok_or("Missing remote file")?).await?),
            "write"=>{
                ssh.remote_write(&session,&req.path.ok_or("Missing remote file")?,
                    &req.content.ok_or("Missing file contents")?).await?;
                json!({"written":true})
            },
            _=>return Err("Unknown local agent tool".into())
        };
        Ok::<Value,String>(result)
    };
    let response=tokio::time::timeout(Duration::from_secs(80),result).await
        .unwrap_or_else(|_|Err("Local SSH bridge request timed out".into()));
    let encoded=serde_json::to_vec(&match response{
        Ok(value)=>json!({"ok":true,"result":value}),
        Err(message)=>json!({"ok":false,"error":message})
    }).unwrap_or_default();
    if encoded.len()<=MAX_RPC{
        let _=socket.write_u32(encoded.len() as u32).await;
        let _=socket.write_all(&encoded).await;
    }
}
async fn grant_session(bridge:&LocalAgentBridge,ssh:SshSessionManager,session:&str,agent:&str,app:tauri::AppHandle)->Result<(SocketAddr,String),String>{
    // Validate the session before generating a grant.
    if !ssh.active_sessions()?.iter().any(|live|live.id==session){
        return Err("Select a live authenticated SSH session".into());
    }
    let mut address=bridge.address.lock().await;
    let addr=if let Some(addr)=*address{addr}else{
        let listener=TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST,0)).await
            .map_err(|_|"Cannot bind local-only SSH tool bridge".to_owned())?;
        let addr=listener.local_addr().map_err(|_|"Cannot resolve local bridge address".to_owned())?;
        let grants=bridge.grants.clone();
        tauri::async_runtime::spawn(async move{
            while let Ok((socket,peer))=listener.accept().await{
                if !peer.ip().is_loopback(){continue;}
                let grants=grants.clone();let ssh=ssh.clone();let app=app.clone();
                tauri::async_runtime::spawn(async move{
                    let _=tokio::time::timeout(Duration::from_secs(90),
                        serve_connection(socket,grants,ssh,app)).await;
                });
            }
        });
        *address=Some(addr);
        addr
    };
    let bytes:[u8;32]=rand::random();
    let token=bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();
    let launch_id=format!("{:032x}",rand::random::<u128>());
    bridge.grants.lock().map_err(|_|"Cannot issue local CLI grant")?
        .insert(token.clone(),Grant{id:launch_id,agent:agent.to_owned(),
            session:session.to_owned(),created:Instant::now()});
    Ok((addr,token))
}

/// List only current, unexpired SSH capabilities, never raw bridge tokens.
/// A native SSH disconnect or Vault lock makes the corresponding grants unusable.
#[tauri::command]
pub fn local_agent_connections(bridge:State<'_,LocalAgentBridge>,
    ssh:State<'_,SshSessionManager>,vault:State<'_,SessionStore>
)->Result<Vec<LocalAgentConnection>,String>{
    if !vault.live_without_touch()?{
        ssh.stop_all();
        bridge.grants.lock().map_err(|_|"Local CLI grants unavailable")?.clear();
        return Ok(Vec::new());
    }
    let active=ssh.active_sessions()?;
    let mut guard=bridge.grants.lock().map_err(|_|"Local CLI grants unavailable")?;
    guard.retain(|_,grant|grant.created.elapsed()<=GRANT_MAX_AGE
        &&active.iter().any(|session|session.id==grant.session));
    let mut items=guard.values().filter_map(|grant|{
        let host=active.iter().find(|session|session.id==grant.session)?.alias.clone();
        Some(LocalAgentConnection{id:grant.id.clone(),agent:grant.agent.clone(),
            session_id:grant.session.clone(),host,
            age_seconds:grant.created.elapsed().as_secs()})
    }).collect::<Vec<_>>();
    items.sort_by(|a,b|a.host.cmp(&b.host).then(a.agent.cmp(&b.agent)));
    Ok(items)
}
/// Removing a grant blocks all subsequent MCP calls from that local console.
/// It intentionally leaves the user's independently signed-in CLI running.
#[tauri::command]
pub fn local_agent_revoke(id:String,bridge:State<'_,LocalAgentBridge>)->Result<bool,String>{
    if id.len()!=32||!id.as_bytes().iter().all(u8::is_ascii_hexdigit){
        return Err("Invalid local agent grant identifier".into());
    }
    revoke_grant_by_id(&bridge.grants,&id)
}

// OpenCode V1 uses mcp.<name>; V2 requires mcp.servers.<name>.
// Query the actual local executable instead of assuming a schema from the
// name of the package or the existence of an unrelated GUI application.
fn opencode_major_from_version(raw:&str)->Option<u32>{
    raw.split(|c:char|!c.is_ascii_digit()&&c!='.')
        .find(|part|part.chars().next().is_some_and(|ch|ch.is_ascii_digit()))
        .and_then(|part|part.split('.').next()?.parse::<u32>().ok())
}
fn opencode_major_version(cli:&Path)->Result<u32,String>{
    let mut cmd=if cfg!(windows){
        let mut cmd=Command::new("powershell.exe");
        cmd.args(["-NoProfile","-NonInteractive","-Command",
            &format!("& {} --version",ps_quote(&cli.to_string_lossy()))]);cmd
    }else{
        let mut cmd=Command::new(cli);cmd.arg("--version");cmd
    };
    let mut child=cmd.stdin(Stdio::null()).stdout(Stdio::piped())
        .stderr(Stdio::piped()).spawn()
        .map_err(|_|"Could not inspect local OpenCode CLI version")?;
    let started=Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status))=>{
                let out=child.wait_with_output().map_err(|_|"OpenCode version output unavailable")?;
                if !status.success(){return Err("OpenCode --version failed".into());}
                let text=format!("{} {}",String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr));
                return opencode_major_from_version(&text)
                    .filter(|major|*major>=1)
                    .ok_or_else(||"Cannot determine OpenCode major version for MCP configuration".into());
            },
            Ok(None) if started.elapsed()>=Duration::from_secs(5)=>{
                let _=child.kill();let _=child.wait();
                return Err("OpenCode version probe timed out".into());
            },
            Err(_)=>return Err("OpenCode version probe failed".into()),
            _=>std::thread::sleep(Duration::from_millis(40))
        }
    }
}
fn is_opencode_v2_config(path:Option<&Path>)->bool{
    path.and_then(Path::file_name).is_some_and(|name|name=="opencode.json")
}
fn cleanup_temp_config(path:Option<&Path>){
    if let Some(path)=path{
        let _=fs::remove_file(path);
        if is_opencode_v2_config(Some(path)){
            // Our private workspace was created exclusively for this launch.
            if let Some(dir)=path.parent(){let _=fs::remove_dir(dir);}
        }
    }
}
// An empty, disposable local cwd is important: built-in agent shell/file tools
// must never accidentally treat PaSSH7's installation directory as the SSH host.
// Codex/OpenCode read AGENTS.md; Claude Code reads CLAUDE.md from their cwd.
const REMOTE_WORKSPACE_INSTRUCTIONS:&str="You were started locally by PaSSH7 to work on the SSH host selected in the PaSSH7 app.\n\nFor ALL commands and file operations on that host, use the passh7 MCP tools: remote_exec, remote_list, remote_read, and remote_write. Your built-in shell and file tools operate on the LOCAL machine, not the SSH host. Do not run host commands using your local shell or another SSH connection.\n\nThis is not a sandbox. Confirm destructive operations with the user and never reveal credentials. If PaSSH7's MCP tools are unavailable, tell the user and stop remote actions rather than silently using local tools.\n";
fn prepare_agent_workspace(config:Option<&Path>)->Result<PathBuf,String>{
    let dir=if is_opencode_v2_config(config){
        config.and_then(Path::parent).ok_or("Missing OpenCode V2 working directory")?.to_path_buf()
    }else{
        let dir=std::env::temp_dir().join(format!("passh7-agent-workspace-{}",rand::random::<u64>()));
        fs::create_dir(&dir).map_err(|_|"Cannot create private agent working directory")?;
        dir
    };
    let result=(||->Result<(),String>{
        for filename in ["AGENTS.md","CLAUDE.md"]{
            let file=dir.join(filename);
            let mut f=OpenOptions::new().write(true).create_new(true).open(file)
                .map_err(|_|"Cannot create temporary agent instructions")?;
            f.write_all(REMOTE_WORKSPACE_INSTRUCTIONS.as_bytes())
                .map_err(|_|"Cannot write temporary agent instructions")?;
        }
        Ok(())
    })();
    if let Err(error)=result{
        for name in ["AGENTS.md","CLAUDE.md"]{let _=fs::remove_file(dir.join(name));}
        if !is_opencode_v2_config(config){let _=fs::remove_dir(&dir);}
        return Err(error);
    }
    Ok(dir)
}
fn cleanup_local_launch(config:Option<&Path>,workspace:&Path){
    for filename in ["AGENTS.md","CLAUDE.md"]{
        let _=fs::remove_file(workspace.join(filename));
    }
    cleanup_temp_config(config);
    if !is_opencode_v2_config(config){let _=fs::remove_dir(workspace);}
}
fn new_config(agent:&str,executable:&Path,opencode_major:Option<u32>)->Result<Option<PathBuf>,String>{
    // Config contains only our own executable path, never SSH/Vault secrets or
    // local-bridge tokens. The CLI process inherits the ephemeral grant via env.
    let exe=executable.to_string_lossy().into_owned();
    if agent=="codex"{return Ok(None);}
    let v2=agent=="opencode"&&opencode_major.is_some_and(|major|major>=2);
    let json=if agent=="claude"{
        json!({"mcpServers":{"passh7":{"command":exe,"args":["--passh7-mcp"]}}})
    }else if v2{
        json!({"mcp":{"servers":{"passh7":{"type":"local","command":[exe,"--passh7-mcp"],"codemode":false}}}})
    }else{
        json!({"mcp":{"passh7":{"type":"local","command":[exe,"--passh7-mcp"],"enabled":true}}})
    };
    let bytes=serde_json::to_vec_pretty(&json).map_err(|_|"Cannot encode agent MCP config")?;
    let path=if v2{
        // OpenCode V2 ignores OPENCODE_CONFIG on affected versions.
        // Use a private project workspace, which V2 definitely discovers.
        let dir=std::env::temp_dir().join(format!("passh7-opencode-v2-{}",rand::random::<u64>()));
        fs::create_dir(&dir).map_err(|_|"Cannot create OpenCode V2 workspace")?;
        dir.join("opencode.json")
    }else{
        std::env::temp_dir().join(format!("passh7-{agent}-{}.json",rand::random::<u64>()))
    };
    let result=(||->Result<(),String>{
        let mut f=OpenOptions::new().write(true).create_new(true).open(&path)
            .map_err(|_|"Cannot create temporary MCP configuration")?;
        f.write_all(&bytes).map_err(|_|"Cannot write temporary MCP configuration")?;
        Ok(())
    })();
    if let Err(err)=result{cleanup_temp_config(Some(&path));return Err(err);}
    Ok(Some(path))
}
fn shell_launch_command(agent:&str,cli:&Path,self_exe:&Path,config:Option<&Path>)->String{
    let binary=ps_quote(&cli.to_string_lossy());
    if agent=="codex"{
        let cmd=format!("mcp_servers.passh7.command={}",serde_json::to_string(&self_exe.to_string_lossy().to_string()).unwrap_or_default());
        let args="mcp_servers.passh7.args=[\"--passh7-mcp\"]";
        // Codex isolates MCP child environments and may scrub *TOKEN* names.
        // Forward ONLY the ephemeral PaSSH7 bridge variables, not provider
        // tokens or the entire local environment. Values stay in process env.
        let inherited="mcp_servers.passh7.env_vars=[\"PASSH7_BRIDGE_ADDR\",\"PASSH7_BRIDGE_TOKEN\"]";
        format!("& {binary} -c {} -c {} -c {}",ps_quote(&cmd),ps_quote(args),ps_quote(inherited))
    }else if agent=="claude"{
        format!("& {binary} --mcp-config {}",ps_quote(&config.unwrap().to_string_lossy()))
    }else if is_opencode_v2_config(config){
        // Force a private V2 server so it loads this workspace's MCP config.
        format!("& {binary} --standalone")
    }else{format!("& {binary}")}
}
#[tauri::command]
pub async fn local_agent_launch(agent:String,id:String,app:tauri::AppHandle,
    bridge:State<'_,LocalAgentBridge>,ssh:State<'_,SshSessionManager>,vault:State<'_,SessionStore>
)->Result<String,String>{
    allowed_agent(&agent)?;
    if !cfg!(windows){
        return Err("Interactive local CLI launch currently requires Windows desktop. Remote CLI over SSH remains available.".into());
    }
    if !vault.touch_if_live()?{return Err("Unlock Vault before granting a local agent SSH access".into());}
    let agent_name=agent.clone();
    let cli=tokio::task::spawn_blocking(move||discover_local_cli(&agent_name)).await
        .map_err(|_|"Local CLI detection failed".to_owned())??;
    // Perform all fallible local setup before issuing an SSH capability token.
    let self_exe=std::env::current_exe().map_err(|_|"PaSSH7 executable path unavailable")?;
    let major=if agent=="opencode"{
        let path=cli.clone();
        Some(tokio::task::spawn_blocking(move||opencode_major_version(&path)).await
            .map_err(|_|"OpenCode CLI version probe interrupted".to_owned())??)
    }else{None};
    let config=new_config(&agent,&self_exe,major)?;
    let workspace=match prepare_agent_workspace(config.as_deref()){
        Ok(path)=>path,
        Err(error)=>{cleanup_temp_config(config.as_deref());return Err(error);}
    };
    let (address,token)=match grant_session(bridge.inner(),ssh.inner().clone(),&id,&agent,app).await{
        Ok(grant)=>grant,
        Err(error)=>{
            cleanup_local_launch(config.as_deref(),&workspace);
            return Err(error);
        }
    };
    let mut cmd=if cfg!(windows){Command::new("powershell.exe")}else{Command::new("sh")};
    if cfg!(windows){
        cmd.args(["-NoLogo","-NoProfile","-Command",
            &shell_launch_command(&agent,&cli,&self_exe,config.as_deref())]);
        #[cfg(windows)]{
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x00000010); // CREATE_NEW_CONSOLE
        }
    }else{
        // On Unix use a terminal emulator only when actually installed. It is
        // never installed onto the remote host; local CLI owns its login state.
        let _=config.as_ref();
        return Err("Local interactive CLI launch currently requires Windows; Unix desktop terminal integration is not enabled.".into());
    }
    cmd.current_dir(&workspace);
    // The local CLI is interactive. Do NOT redirect its standard handles to
    // NUL: terminal coding assistants would start but could not accept input
    // or render their UI in the newly created Windows console. CREATE_NEW_CONSOLE
    // above provides an interactive terminal for this child process.
    cmd.env("PASSH7_BRIDGE_ADDR",address.to_string())
        .env("PASSH7_BRIDGE_TOKEN",&token);
    if let Some(path)=config.as_ref(){
        if agent=="opencode"{
            if is_opencode_v2_config(Some(path)){
                if let Some(dir)=path.parent(){cmd.current_dir(dir);}
                // V2 currently ignores these legacy overrides; avoid inheriting
                // a stale config from PaSSH7's own parent process.
                cmd.env_remove("OPENCODE_CONFIG").env_remove("OPENCODE_CONFIG_CONTENT");
            }else{cmd.env("OPENCODE_CONFIG",path);}
        }
    }
    let child=cmd.spawn().map_err(|e|format!("Cannot open local CLI terminal: {e}"));
    match child{
        Ok(mut child)=>{
            let grants=bridge.grants.clone();
            std::thread::spawn(move||{
                let _=child.wait();
                if let Ok(mut active)=grants.lock(){active.remove(&token);}
                cleanup_local_launch(config.as_deref(),&workspace);
            });
            Ok(format!("Launched local {agent} CLI in a separate console with SSH tool access to the selected authenticated session. Local CLI login remains unchanged."))
        },
        Err(error)=>{
            if let Ok(mut active)=bridge.grants.lock(){active.remove(&token);}
            cleanup_local_launch(config.as_deref(),&workspace);
            Err(error)
        }
    }
}
fn rpc_call(name:&str,args:&Value)->Result<Value,String>{
    let address=std::env::var("PASSH7_BRIDGE_ADDR")
        .map_err(|_|"Not launched by PaSSH7 (bridge address missing)")?;
    if !address.starts_with("127.0.0.1:"){return Err("Invalid local-only bridge address".into());}
    let token=std::env::var("PASSH7_BRIDGE_TOKEN")
        .map_err(|_|"Not launched by PaSSH7 (grant missing)")?;
    let addr:SocketAddr=address.parse().map_err(|_|"Invalid bridge address")?;
    let mut stream=TcpStream::connect_timeout(&addr,Duration::from_secs(3))
        .map_err(|_|"PaSSH7 is not running or its local bridge is unavailable")?;
    stream.set_read_timeout(Some(Duration::from_secs(80))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    let req=json!({
        "token":token,"op":name,
        "command":args.get("command"),"path":args.get("path"),"content":args.get("content")
    });
    let bytes=serde_json::to_vec(&req).map_err(|_|"Cannot encode local tool request")?;
    if bytes.len()>MAX_RPC{return Err("Local tool input exceeds 512 KiB".into());}
    stream.write_all(&(bytes.len() as u32).to_be_bytes()).map_err(|_|"Cannot send local tool frame")?;
    stream.write_all(&bytes).map_err(|_|"Cannot send local tool request")?;
    let mut size=[0u8;4];stream.read_exact(&mut size).map_err(|_|"SSH tool response interrupted")?;
    let len=u32::from_be_bytes(size) as usize;
    if len==0||len>MAX_RPC{return Err("Invalid SSH tool response size".into());}
    let mut data=vec![0u8;len];
    stream.read_exact(&mut data).map_err(|_|"Incomplete SSH tool response")?;
    let reply:Value=serde_json::from_slice(&data).map_err(|_|"Malformed SSH tool response")?;
    if reply.get("ok").and_then(Value::as_bool)==Some(true){
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    }else{
        Err(reply.get("error").and_then(Value::as_str).unwrap_or("SSH tool operation failed").to_owned())
    }
}
fn tool(name:&str,description:&str,properties:Value,required:Vec<&str>)->Value{
    json!({"name":name,"description":description,
        "inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
}
fn mcp_tools()->Value{
    json!([
        tool("remote_exec","Run a shell command on the selected authenticated SSH host, never the local machine. Returns separate stdout/stderr and exit code. Limit 60 seconds, 256 KiB output.",
            json!({"command":{"type":"string","description":"Command interpreted by the remote user's SSH shell, not by the local OS"}}),vec!["command"]),
        tool("remote_list","List files in a directory on the selected SSH host via SFTP.",
            json!({"path":{"type":"string"}}),vec!["path"]),
        tool("remote_read","Read a remote UTF-8 text file via SFTP (maximum 256 KiB).",
            json!({"path":{"type":"string"}}),vec!["path"]),
        tool("remote_write","CREATE or OVERWRITE a remote UTF-8 file via SFTP (maximum 256 KiB). Destructive: confirm before editing important files.",
            json!({"path":{"type":"string"},"content":{"type":"string"}}),vec!["path","content"])
    ])
}
fn mcp_tool_text(name:&str,value:&Value)->String{
    // MCP text is the actual file content for remote_read. JSON-encoding a
    // string here forced the agent to see extra quotes and escaped newlines.
    // Structured exec / directory metadata remain JSON for machine parsing.
    if name=="remote_read"{
        value.as_str().map(str::to_owned).unwrap_or_else(||value.to_string())
    }else{value.to_string()}
}
fn mcp_handle(message:&Value)->Option<Value>{
    let id=message.get("id")?.clone();
    let method=message.get("method").and_then(Value::as_str).unwrap_or("");
    let result=match method{
        "initialize"=>json!({"protocolVersion":"2025-06-18",
            "capabilities":{"tools":{"listChanged":false}},
            "serverInfo":{"name":"passh7-ssh","version":env!("CARGO_PKG_VERSION")}}),
        "ping"=>json!({}),
        "tools/list"=>json!({"tools":mcp_tools()}),
        "tools/call"=>{
            let params=message.get("params").cloned().unwrap_or(Value::Null);
            let name=params.get("name").and_then(Value::as_str).unwrap_or("");
            let args=params.get("arguments").cloned().unwrap_or(Value::Null);
            let outcome=if ["remote_exec","remote_list","remote_read","remote_write"].contains(&name){
                rpc_call(name.strip_prefix("remote_").unwrap(),&args)
            }else{Err("Unknown PaSSH7 remote tool".into())};
            match outcome{
                Ok(result)=>json!({"content":[{"type":"text","text":mcp_tool_text(name,&result)}]}),
                Err(message)=>json!({"isError":true,"content":[{"type":"text","text":message}]}),
            }
        },
        _=>return Some(json!({"jsonrpc":"2.0","id":id,
            "error":{"code":-32601,"message":"Unsupported MCP method"}}))
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}
/// Invoked *before* Tauri initializes. stdout is exclusively MCP JSON-RPC.
pub fn run_stdio_mcp(){
    let stdin=std::io::stdin();
    let mut stdout=std::io::stdout().lock();
    for line in stdin.lock().lines(){
        let Ok(line)=line else{break};
        if line.len()>MAX_RPC{continue;}
        if let Ok(message)=serde_json::from_str::<Value>(&line){
            if let Some(response)=mcp_handle(&message){
                if let Ok(bytes)=serde_json::to_vec(&response){
                    if stdout.write_all(&bytes).is_err(){break;}
                    if stdout.write_all(b"\n").is_err(){break;}
                    if stdout.flush().is_err(){break;}
                }
            }
        }
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn opencode_v1_and_v2_configs_match_their_own_schemas(){
        let exe=std::env::current_exe().expect("test executable exists");
        let v1=new_config("opencode",&exe,Some(1)).unwrap().unwrap();
        let v2=new_config("opencode",&exe,Some(2)).unwrap().unwrap();
        let one:Value=serde_json::from_slice(&fs::read(&v1).unwrap()).unwrap();
        let two:Value=serde_json::from_slice(&fs::read(&v2).unwrap()).unwrap();
        assert!(one["mcp"].get("servers").is_none());
        assert_eq!(one["mcp"]["passh7"]["enabled"],true);
        assert_eq!(one["mcp"]["passh7"]["command"][1],"--passh7-mcp");
        assert!(two["mcp"].get("passh7").is_none());
        assert_eq!(two["mcp"]["servers"]["passh7"]["type"],"local");
        assert_eq!(two["mcp"]["servers"]["passh7"]["codemode"],false);
        assert_eq!(two["mcp"]["servers"]["passh7"]["command"][1],"--passh7-mcp");
        assert!(is_opencode_v2_config(Some(&v2)));
        assert!(!is_opencode_v2_config(Some(&v1)));
        let launch=shell_launch_command("opencode",&exe,&exe,Some(&v2));
        assert!(launch.contains("--standalone"));
        assert!(!one.to_string().contains("PASSH7_BRIDGE_TOKEN"));
        assert!(!two.to_string().contains("PASSH7_BRIDGE_TOKEN"));
        let parent=v2.parent().unwrap().to_path_buf();
        cleanup_temp_config(Some(&v1));
        cleanup_temp_config(Some(&v2));
        assert!(!v1.exists());
        assert!(!parent.exists());
    }
    #[test]
    fn local_agents_start_in_disposable_remote_tool_workspace(){
        let path=prepare_agent_workspace(None).unwrap();
        for name in ["AGENTS.md","CLAUDE.md"]{
            let read=fs::read_to_string(path.join(name)).unwrap();
            assert!(read.contains("passh7 MCP tools"));
            assert!(read.contains("LOCAL machine"));
            assert!(!read.contains("PASSH7_BRIDGE_TOKEN"));
        }
        cleanup_local_launch(None,&path);
        assert!(!path.exists());
    }
    #[test]
    fn opencode_version_probe_recognizes_v1_and_v2(){
        assert_eq!(opencode_major_from_version("OpenCode v1.18.35"),Some(1));
        assert_eq!(opencode_major_from_version("opencode v2.0.26"),Some(2));
        assert_eq!(opencode_major_from_version("version unavailable"),None);
    }
    #[test]
    fn capability_revocation_targets_only_one_local_agent_grant(){
        let grants:Grants=Arc::new(Mutex::new(HashMap::new()));
        let first="11111111111111111111111111111111".to_owned();
        let second="22222222222222222222222222222222".to_owned();
        {
            let mut guard=grants.lock().unwrap();
            guard.insert("private-secret-1".into(),Grant{id:first.clone(),
                agent:"codex".into(),session:"ssh-a".into(),created:Instant::now()});
            guard.insert("private-secret-2".into(),Grant{id:second.clone(),
                agent:"claude".into(),session:"ssh-b".into(),created:Instant::now()});
        }
        assert!(revoke_grant_by_id(&grants,&first).unwrap());
        assert!(!revoke_grant_by_id(&grants,&first).unwrap());
        let current=grants.lock().unwrap();
        assert_eq!(current.len(),1);
        assert!(current.contains_key("private-secret-2"));
        assert!(!current.contains_key("private-secret-1"));
    }
    #[test]
    fn codex_explicitly_forwards_ephemeral_bridge_vars_without_values(){
        let exe=std::env::current_exe().unwrap();
        let command=shell_launch_command("codex",&exe,&exe,None);
        assert!(command.contains("mcp_servers.passh7.env_vars="));
        assert!(command.contains("PASSH7_BRIDGE_ADDR"));
        assert!(command.contains("PASSH7_BRIDGE_TOKEN"));
        assert!(command.contains("mcp_servers.passh7.args="));
        assert!(!command.contains("PASSH7_BRIDGE_TOKEN="));
        assert!(!command.contains("OPENAI_API_KEY"));
    }
    #[test]
    fn only_three_cli_kinds_are_allowed(){
        assert!(allowed_agent("codex").is_ok());
        assert!(allowed_agent("claude").is_ok());
        assert!(allowed_agent("opencode").is_ok());
        assert!(allowed_agent("powershell -evil").is_err());
    }
    #[test]
    fn mcp_remote_read_preserves_utf8_and_line_breaks(){
        let value=json!("first line\nдруга лінія\n");
        assert_eq!(mcp_tool_text("remote_read",&value),"first line\nдруга лінія\n");
        assert_eq!(mcp_tool_text("remote_list",&json!([{"name":"data"}])),r#"[{"name":"data"}]"#);
    }
    #[test]
    fn mcp_has_expected_tools_and_no_secrets_in_schema(){
        let catalog=mcp_tools();
        let names=catalog.as_array().unwrap().iter()
            .filter_map(|x|x.get("name").and_then(Value::as_str)).collect::<Vec<_>>();
        assert_eq!(names,vec!["remote_exec","remote_list","remote_read","remote_write"]);
        assert!(!mcp_tools().to_string().contains("PASSH7_BRIDGE_TOKEN"));
    }
    #[test]
    fn stdio_mcp_initialize_and_tool_discovery_have_protocol_shape(){
        let init=mcp_handle(&json!({"jsonrpc":"2.0","id":1,"method":"initialize"})).unwrap();
        assert_eq!(init["result"]["protocolVersion"],"2025-06-18");
        let tools=mcp_handle(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).unwrap();
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(),4);
        assert!(mcp_handle(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
    }
}
