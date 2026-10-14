use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use passh7_core::{HostProfile, Identity, Vault};
use std::{fs, path::{Path, PathBuf}};
use zeroize::Zeroizing;

#[derive(Parser)]
#[command(name = "passh7", version, about = "PaSSH7 experimental encrypted SSH vault")]
struct Args {
    #[arg(long, global = true, default_value = "passh7-vault.json")]
    vault: PathBuf,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Init,
    List,
    ImportKey { #[arg(long)] alias: String, #[arg(long)] file: PathBuf },
    AddHost { #[arg(long)] alias: String, #[arg(long)] hostname: String,
        #[arg(long, default_value_t = 22)] port: u16, #[arg(long)] username: String,
        #[arg(long)] identity: String, #[arg(long)] pinned_host_key: Option<String> },
}
fn prompt(confirm: bool) -> Result<Zeroizing<String>> {
    let password = Zeroizing::new(rpassword::prompt_password("Master password: ")?);
    if confirm {
        let again = Zeroizing::new(rpassword::prompt_password("Confirm master password: ")?);
        if *password != *again { bail!("passwords do not match"); }
    }
    Ok(password)
}
fn with_vault<F>(path: &Path, update: F) -> Result<()>
where F: FnOnce(&mut Vault) -> Result<bool> {
    let password = prompt(false)?;
    let mut vault = passh7_core::load(path, &password).context("unable to unlock vault")?;
    if update(&mut vault)? {
        passh7_core::save(path, &vault, &password)
            .context("unable to save encrypted vault")?;
        println!("Vault updated");
    }
    Ok(())
}
fn main() -> Result<()> {
    let args = Args::parse();
    match args.command {
        Command::Init => {
            let password = prompt(true)?;
            passh7_core::create(&args.vault, &password)?;
            println!("Vault created at {}", args.vault.display());
        }
        Command::List => with_vault(&args.vault, |vault| {
            println!("Identities: {}", vault.identities.len());
            for h in &vault.hosts {
                println!("{} -> {}@{}:{} (identity: {}, pinned: {})",
                    h.alias, h.username, h.hostname, h.port, h.identity_alias, h.pinned_host_key.is_some());
            }
            Ok(false)
        })?,
        Command::ImportKey { alias, file } => {
            if fs::metadata(&file)?.len() > 128 * 1024 { bail!("private key file too large"); }
            let key = Zeroizing::new(fs::read_to_string(&file)?);
            with_vault(&args.vault, |v| {
                v.add_identity(Identity { alias, private_key_pem: (*key).clone() })?;
                Ok(true)
            })?;
        }
        Command::AddHost { alias, hostname, port, username, identity, pinned_host_key } => {
            with_vault(&args.vault, |v| {
                v.add_host(HostProfile { alias, hostname, port, username,
                    identity_alias: identity, pinned_host_key })?;
                Ok(true)
            })?;
        }
    }
    Ok(())
}