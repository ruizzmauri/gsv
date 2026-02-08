use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_SESSION_KEY: &str = "agent:main:cli:dm:main";

/// Normalize legacy/alias session keys to canonical format.
pub fn normalize_session_key(raw: &str) -> String {
    let trimmed = raw.trim();

    if trimmed.is_empty() || trimmed == "main" {
        return DEFAULT_SESSION_KEY.to_string();
    }

    trimmed.to_string()
}

/// CLI configuration loaded from ~/.config/gsv/config.toml
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CliConfig {
    /// Gateway connection settings
    #[serde(default)]
    pub gateway: GatewayConfig,

    /// R2 storage settings (for mount command)
    #[serde(default)]
    pub r2: R2Config,

    /// Default session settings
    #[serde(default)]
    pub session: SessionConfig,

    /// Channel settings
    #[serde(default)]
    pub channels: ChannelsConfig,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ChannelsConfig {
    /// WhatsApp channel settings
    #[serde(default)]
    pub whatsapp: WhatsAppChannelConfig,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct WhatsAppChannelConfig {
    /// WhatsApp channel worker URL (e.g., https://gsv-channel-whatsapp.example.workers.dev)
    pub url: Option<String>,

    /// Auth token for WhatsApp channel
    pub token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GatewayConfig {
    /// WebSocket URL for the gateway
    pub url: Option<String>,

    /// Auth token
    pub token: Option<String>,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            url: None,
            token: None,
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct R2Config {
    /// Cloudflare Account ID
    pub account_id: Option<String>,

    /// R2 Access Key ID
    pub access_key_id: Option<String>,

    /// R2 Secret Access Key
    pub secret_access_key: Option<String>,

    /// R2 bucket name
    pub bucket: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionConfig {
    /// Default session key
    pub default_key: Option<String>,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            default_key: Some(DEFAULT_SESSION_KEY.to_string()),
        }
    }
}

impl CliConfig {
    /// Get the config file path
    pub fn config_path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("gsv").join("config.toml"))
    }

    /// Load config from file, returning default if file doesn't exist
    pub fn load() -> Self {
        let Some(path) = Self::config_path() else {
            return Self::default();
        };

        if !path.exists() {
            return Self::default();
        }

        match std::fs::read_to_string(&path) {
            Ok(content) => toml::from_str(&content).unwrap_or_else(|e| {
                eprintln!("Warning: Failed to parse config: {}", e);
                Self::default()
            }),
            Err(e) => {
                eprintln!("Warning: Failed to read config: {}", e);
                Self::default()
            }
        }
    }

    /// Save config to file
    pub fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let Some(path) = Self::config_path() else {
            return Err("Could not determine config directory".into());
        };

        // Create directory if needed
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let content = toml::to_string_pretty(self)?;
        std::fs::write(&path, content)?;
        Ok(())
    }

    /// Get effective gateway URL (config -> default)
    pub fn gateway_url(&self) -> String {
        self.gateway
            .url
            .clone()
            .unwrap_or_else(|| "ws://localhost:8787/ws".to_string())
    }

    /// Get effective token (config only, no default)
    pub fn gateway_token(&self) -> Option<String> {
        self.gateway.token.clone()
    }

    /// Get default session key
    pub fn default_session(&self) -> String {
        let raw = self
            .session
            .default_key
            .as_deref()
            .unwrap_or(DEFAULT_SESSION_KEY);
        normalize_session_key(raw)
    }

    /// Get the GSV home directory (~/.gsv)
    pub fn gsv_home(&self) -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".gsv")
    }

    /// Get the R2 mount path
    pub fn r2_mount_path(&self) -> PathBuf {
        self.gsv_home().join("r2")
    }

    /// Get WhatsApp channel URL (config -> env var)
    pub fn whatsapp_url(&self) -> Option<String> {
        self.channels
            .whatsapp
            .url
            .clone()
            .or_else(|| std::env::var("WHATSAPP_CHANNEL_URL").ok())
    }

    /// Get WhatsApp channel auth token
    pub fn whatsapp_token(&self) -> Option<String> {
        self.channels
            .whatsapp
            .token
            .clone()
            .or_else(|| std::env::var("WHATSAPP_CHANNEL_TOKEN").ok())
    }
}

/// Generate a sample config file content
pub fn sample_config() -> &'static str {
    r#"# GSV CLI Configuration
# Location: ~/.config/gsv/config.toml

[gateway]
# WebSocket URL for the gateway (required for remote)
url = "wss://gateway.stevej.workers.dev/ws"

# Auth token (keep secret!)
token = "your-token-here"

[r2]
# Cloudflare R2 credentials (for 'gsv mount' command)
# account_id = "your-account-id"
# access_key_id = "your-access-key"
# secret_access_key = "your-secret-key"
# bucket = "gsv-storage"

[session]
# Default session key
default_key = "agent:main:cli:dm:main"

[channels.whatsapp]
# WhatsApp channel worker URL
# url = "https://gsv-channel-whatsapp.example.workers.dev"
# token = "your-whatsapp-channel-token"
"#
}
