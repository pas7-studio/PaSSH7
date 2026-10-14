use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use passh7_core::{HostProfile, HubError, Identity, Vault};
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
    ChangePassword,
    PinHost { #[arg(long)] alias: String, #[arg(long)] fingerprint: String },
    RemoveHost { #[arg(long)] alias: String },
    RemoveKey { #[arg(long)] alias: String },
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
where F: FnOnce(&mut Vault) -> Result<bool, HubError> {
    let password = prompt(false)?;
    passh7_core::transaction(path, &password, update).context("vault transaction failed")?;
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
        Command::PinHost { alias, fingerprint } => with_vault(&args.vault, |v| {
            v.pin_host_key(&alias, &fingerprint)?;
            Ok(true)
        })?,
        Command::ChangePassword => {
            let old_password = prompt(false)?;
            println!("Enter a new master password (12 characters minimum):");
            let new_password = prompt(true)?;
            passh7_core::rotate_password(&args.vault, &old_password, &new_password)
                .context("unable to rotate encrypted vault")?;
            println!("Master password changed; retain encrypted recovery backups securely");
        }
        Command::RemoveHost { alias } => with_vault(&args.vault, |v| {
            v.remove_host(&alias)?;
            Ok(true)
        })?,
        Command::RemoveKey { alias } => with_vault(&args.vault, |v| {
            v.remove_identity(&alias)?;
            Ok(true)
        })?,
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
                v.add_identity(Identity { extensions: Default::default(), alias, private_key_pem: (*key).clone() })?;
                Ok(true)
            })?;
        }
        Command::AddHost { alias, hostname, port, username, identity, pinned_host_key } => {
            with_vault(&args.vault, |v| {
                v.add_host(HostProfile { extensions: Default::default(), alias, hostname, port, username,
                    identity_alias: identity, pinned_host_key })?;
                Ok(true)
            })?;
        }
    }
    Ok(())
}