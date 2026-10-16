use std::{collections::HashSet, path::PathBuf};
use serde::Serialize;

/// Only explicit, direct OpenSSH host blocks are imported. OpenSSH Include,
/// Match, wildcards, ProxyCommand and ProxyJump have semantics which the
/// native PaSSH7 client does not currently replicate, so those are skipped.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct LocalSshConfigHost {
    pub alias: String,
    pub hostname: String,
    pub username: String,
    pub port: u16,
}

#[derive(Default)]
struct Block {
    aliases: Vec<String>,
    hostname: Option<String>,
    username: Option<String>,
    port: Option<u16>,
    proxy: bool,
}

fn parse_openssh_config(content:&str)->Vec<LocalSshConfigHost>{
    let mut found=Vec::new();
    let mut seen=HashSet::new();
    let mut current=Block::default();

    fn flush(block:&mut Block,found:&mut Vec<LocalSshConfigHost>,seen:&mut HashSet<String>){
        if !block.proxy {
            for alias in &block.aliases {
                if found.len()>=100 {break;}
                let hostname=block.hostname.as_deref().unwrap_or(alias);
                // OpenSSH %-expansion, shell metacharacters and glob patterns
                // need full config semantics. Never guess their interpretation.
                if hostname.is_empty() || hostname.len()>253 ||
                   hostname.chars().any(|c|c.is_whitespace() || c.is_control() ||
                       c=='%' || c=='*' || c=='?' || c=='!' || c=='#') {continue;}
                if seen.insert(alias.clone()){
                    found.push(LocalSshConfigHost{
                        alias:alias.clone(),
                        hostname:hostname.to_owned(),
                        username:block.username.clone().unwrap_or_default(),
                        port:block.port.unwrap_or(22)
                    });
                }
            }
        }
        *block=Block::default();
    }

    for raw in content.trim_start_matches('\u{feff}').lines(){
        let line=raw.trim();
        if line.is_empty() || line.starts_with('#'){continue;}
        let mut parts=line.splitn(2,|c:char|c.is_whitespace() || c=='=');
        let directive=parts.next().unwrap_or("").to_ascii_lowercase();
        let value=parts.next().unwrap_or("")
            .trim().trim_start_matches('=').trim()
            .split('#').next().unwrap_or("").trim();
        match directive.as_str(){
            "host"=>{
                flush(&mut current,&mut found,&mut seen);
                current.aliases=value.split_whitespace()
                    .filter(|alias|!alias.is_empty() && alias.len()<=128 &&
                        alias.chars().all(|ch|ch.is_ascii_alphanumeric() ||
                            matches!(ch,'.'|'-'|'_'|':'|'@')))
                    .map(str::to_owned).collect();
            },
            "match"=>{flush(&mut current,&mut found,&mut seen);},
            "include"=>{/* Skipped, rather than reading arbitrary included files. */},
            "hostname" if !current.aliases.is_empty() && current.hostname.is_none()=>{
                current.hostname=Some(value.trim_matches('"').to_owned());
            },
            "user" if !current.aliases.is_empty() && current.username.is_none()=>{
                if !value.is_empty() && value.len()<=128 &&
                    !value.chars().any(|c|c.is_whitespace() || c.is_control()){
                    current.username=Some(value.to_owned());
                }
            },
            "port" if !current.aliases.is_empty() && current.port.is_none()=>{
                current.port=value.parse::<u16>().ok().filter(|p|*p>0);
            },
            "proxyjump"|"proxycommand" if !current.aliases.is_empty()=>{
                if !value.eq_ignore_ascii_case("none"){current.proxy=true;}
            },
            _=>{}
        }
    }
    flush(&mut current,&mut found,&mut seen);
    found
}

#[tauri::command]
pub fn ssh_discover_local_config_hosts()->Result<Vec<LocalSshConfigHost>,String>{
    let home=std::env::var_os("USERPROFILE").or_else(||std::env::var_os("HOME"))
        .ok_or("Could not locate your home directory for OpenSSH config")?;
    let path=PathBuf::from(home).join(".ssh").join("config");
    if !path.exists(){return Ok(vec![]);}
    let metadata=std::fs::metadata(&path)
        .map_err(|e|format!("Cannot inspect local OpenSSH config: {e}"))?;
    if !metadata.is_file(){return Err("OpenSSH config is not a regular file".into());}
    if metadata.len()>512*1024{return Err("OpenSSH config exceeds 512 KiB import safety limit".into());}
    let text=std::fs::read_to_string(&path)
        .map_err(|e|format!("Cannot read local UTF-8 OpenSSH config: {e}"))?;
    Ok(parse_openssh_config(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_direct_hosts_without_keys_or_proxy_profiles(){
        let config=r#"
Host alpha beta
 HostName 192.168.0.55
 User ubuntu
 Port 2222
 IdentityFile ~/.ssh/id_ed25519
Host *
 User fallback
Host proxy
 HostName proxy.example.com
 ProxyJump bastion
Host windows
 HostName win.example.org
 User Administrator
Host alpha
 HostName wrong.example.org
Match host *
 User replaced
"#;
        let hosts=parse_openssh_config(config);
        assert_eq!(hosts.len(),3);
        assert_eq!(hosts[0].alias,"alpha");
        assert_eq!(hosts[1].alias,"beta");
        assert_eq!(hosts[0].hostname,"192.168.0.55");
        assert_eq!(hosts[0].port,2222);
        assert_eq!(hosts[0].username,"ubuntu");
        assert_eq!(hosts[2].alias,"windows");
        assert_eq!(hosts[2].port,22);
    }

    #[test]
    fn skips_wildcard_include_shell_and_percent_expansion(){
        let cfg=r#"
Include ~/.ssh/work/*.conf
Host *.example
 HostName match.example
Host jump
 ProxyCommand ssh -W %h:%p bastion
Host dynamic
 HostName %h.example.com
Host plain
 HostName server.internal
 Port 0
"#;
        let hosts=parse_openssh_config(cfg);
        assert_eq!(hosts.len(),1);
        assert_eq!(hosts[0].alias,"plain");
        assert_eq!(hosts[0].hostname,"server.internal");
        assert_eq!(hosts[0].port,22);
    }
}
