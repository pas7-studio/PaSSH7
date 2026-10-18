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
use tauri::State;
use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener,sync::Mutex as AsyncMutex};
use crate::{SessionStore,ssh_sessions::SshSessionManager};

const MAX_RPC:usize=2*1024*1024;
const GRANT_MAX_AGE:Duration=Duration::from_secs(12*3600);
type Grants=Arc<Mutex<HashMap<String,Grant>>>;
struct Grant{session:String,created:Instant}

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
async fn serve_connection(mut socket:tokio::net::TcpStream,grants:Grants,ssh:SshSessionManager){
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
async fn grant_session(bridge:&LocalAgentBridge,ssh:SshSessionManager,session:&str)->Result<(SocketAddr,String),String>{
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
                let grants=grants.clone();let ssh=ssh.clone();
                tauri::async_runtime::spawn(async move{
                    let _=tokio::time::timeout(Duration::from_secs(90),
                        serve_connection(socket,grants,ssh)).await;
                });
            }
        });
        *address=Some(addr);
        addr
    };
    let bytes:[u8;32]=rand::random();
    let token=bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();
    bridge.grants.lock().map_err(|_|"Cannot issue local CLI grant")?
        .insert(token.clone(),Grant{session:session.to_owned(),created:Instant::now()});
    Ok((addr,token))
}

fn has_opencode_v2_config(version:&str)->bool{
    version.split(|ch:char|!ch.is_ascii_digit()&&ch!='.')
        .find(|part|part.chars().next().is_some_and(|x|x.is_ascii_digit()))
        .and_then(|value|value.split('.').next())
        .and_then(|value|value.parse::<u32>().ok())
        .is_some_and(|major|major>=2)
}
fn opencode_v2(cli:&Path)->bool{
    // Newer OpenCode versions nest MCP definitions under mcp.servers;
    // older signed-in CLIs expect mcp.<name>. This is the only version
    // distinction required; no OpenCode HTTP server or cloud API is used.
    let mut cmd=if cfg!(windows){
        let mut c=Command::new("powershell.exe");
        c.args(["-NoProfile","-NonInteractive","-Command",
            &format!("& {} --version",ps_quote(&cli.to_string_lossy()))]);c
    }else{
        let mut c=Command::new(cli);c.arg("--version");c
    };
    let Ok(mut child)=cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
        else{return false};
    let start=Instant::now();
    loop{
        match child.try_wait(){
            Ok(Some(status))=>{
                if !status.success(){return false;}
                let Ok(output)=child.wait_with_output() else{return false};
                let version=String::from_utf8_lossy(&output.stdout);
                return has_opencode_v2_config(&version);
            },
            Ok(None) if start.elapsed()>Duration::from_secs(3)=>{
                let _=child.kill();let _=child.wait();return false;
            },
            Err(_)=>return false,
            _=>std::thread::sleep(Duration::from_millis(40))
        }
    }
}
fn new_config(agent:&str,executable:&Path,cli:&Path)->Result<Option<PathBuf>,String>{
    // Config contains only our own executable path, never SSH/Vault secrets or
    // local-bridge tokens. The CLI process inherits the ephemeral grant via env.
    let exe=executable.to_string_lossy().into_owned();
    if agent=="codex"{return Ok(None);}
    let json=if agent=="claude"{
        json!({"mcpServers":{"passh7":{"command":exe,"args":["--passh7-mcp"]}}})
    }else if opencode_v2(cli){
        json!({"mcp":{"servers":{"passh7":{"type":"local","command":[exe,"--passh7-mcp"]}}}})
    }else{
        json!({"mcp":{"passh7":{"type":"local","command":[exe,"--passh7-mcp"],"enabled":true}}})
    };
    let bytes=serde_json::to_vec_pretty(&json).map_err(|_|"Cannot encode agent MCP config")?;
    let name=format!("passh7-{}-{}.json",agent,rand::random::<u64>());
    let path=std::env::temp_dir().join(name);
    let mut opts=OpenOptions::new();opts.write(true).create_new(true);
    let mut f=opts.open(&path).map_err(|_|"Cannot create temporary MCP configuration")?;
    f.write_all(&bytes).map_err(|_|"Cannot write temporary MCP configuration")?;
    Ok(Some(path))
}
fn shell_launch_command(agent:&str,cli:&Path,self_exe:&Path,config:Option<&Path>)->String{
    let binary=ps_quote(&cli.to_string_lossy());
    if agent=="codex"{
        let cmd=format!("mcp_servers.passh7.command={}",serde_json::to_string(&self_exe.to_string_lossy().to_string()).unwrap_or_default());
        let args="mcp_servers.passh7.args=[\"--passh7-mcp\"]";
        format!("& {binary} -c {} -c {}",ps_quote(&cmd),ps_quote(args))
    }else if agent=="claude"{
        format!("& {binary} --mcp-config {}",ps_quote(&config.unwrap().to_string_lossy()))
    }else{format!("& {binary}")}
}
#[tauri::command]
pub async fn local_agent_launch(agent:String,id:String,
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
    let config=new_config(&agent,&self_exe,&cli)?;
    let (address,token)=match grant_session(bridge.inner(),ssh.inner().clone(),&id).await{
        Ok(grant)=>grant,
        Err(error)=>{
            if let Some(path)=config{let _=fs::remove_file(path);}
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
    cmd.env("PASSH7_BRIDGE_ADDR",address.to_string())
        .env("PASSH7_BRIDGE_TOKEN",&token)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(path)=config.as_ref(){
        if agent=="opencode"{cmd.env("OPENCODE_CONFIG",path);}
    }
    let child=cmd.spawn().map_err(|e|format!("Cannot open local CLI terminal: {e}"));
    match child{
        Ok(mut child)=>{
            let grants=bridge.grants.clone();
            std::thread::spawn(move||{
                let _=child.wait();
                if let Ok(mut active)=grants.lock(){active.remove(&token);}
                if let Some(path)=config{let _=fs::remove_file(path);}
            });
            Ok(format!("Launched local {agent} CLI in a separate console with SSH tool access to the selected authenticated session. Local CLI login remains unchanged."))
        },
        Err(error)=>{
            if let Ok(mut active)=bridge.grants.lock(){active.remove(&token);}
            if let Some(path)=config{let _=fs::remove_file(path);}
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
                Ok(result)=>json!({"content":[{"type":"text","text":result.to_string()}]}),
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
    fn opencode_mcp_version_schema_is_backward_compatible(){
        assert!(!has_opencode_v2_config("OpenCode v1.2.3"));
        assert!(has_opencode_v2_config("opencode 2.0.1"));
        assert!(!has_opencode_v2_config("version unavailable"));
    }
    #[test]
    fn only_three_cli_kinds_are_allowed(){
        assert!(allowed_agent("codex").is_ok());
        assert!(allowed_agent("claude").is_ok());
        assert!(allowed_agent("opencode").is_ok());
        assert!(allowed_agent("powershell -evil").is_err());
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
