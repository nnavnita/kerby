use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use std::time::Duration;

#[derive(Clone)]
pub struct ComClient {
    http: reqwest::Client,
    base: String,
    api_key: Option<String>,
}

impl ComClient {
    pub fn new(base: String, api_key: Option<String>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("kerby-worker/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            http,
            base,
            api_key,
        })
    }

    /// Fetch every record in a dataset via the /exports/json endpoint.
    /// This bypasses the 10k offset ceiling on /records.
    pub async fn fetch_export<T: DeserializeOwned>(&self, dataset_id: &str) -> Result<Vec<T>> {
        let url = format!("{}/{}/exports/json", self.base, dataset_id);
        let mut req = self.http.get(&url);
        if let Some(key) = &self.api_key {
            req = req.header("Authorization", format!("apikey {}", key));
        }
        let resp = req.send().await.context("com http send")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("CoM {} returned {}: {}", url, status, body);
        }
        let rows: Vec<T> = resp.json().await.context("com json decode")?;
        Ok(rows)
    }
}
