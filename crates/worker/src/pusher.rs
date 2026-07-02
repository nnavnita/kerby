use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::json;
use sqlx::PgPool;

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";

#[derive(Debug, Clone)]
pub struct Pusher {
    http: reqwest::Client,
}

impl Pusher {
    pub fn new() -> Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()?,
        })
    }

    async fn send(&self, msg: PushMessage<'_>) -> Result<()> {
        let resp = self
            .http
            .post(EXPO_PUSH_URL)
            .header("Accept", "application/json")
            .header("Accept-Encoding", "gzip, deflate")
            .header("Content-Type", "application/json")
            .json(&msg)
            .send()
            .await
            .context("expo push http")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("expo push returned {}: {}", status, body);
        }
        Ok(())
    }

    /// Locked bay just got taken by someone else. Notify the lock holder.
    pub async fn notify_lock_taken(&self, pool: &PgPool, bay_id: &str) -> Result<u64> {
        let rows: Vec<(String, String)> = sqlx::query_as(
            r#"
            SELECT u.push_token, l.id::text
            FROM locks l
            JOIN users u ON u.id = l.user_id
            WHERE l.bay_id = $1
              AND l.released_at IS NULL
              AND l.expires_at > now()
              AND l.taken_notified_at IS NULL
              AND u.push_token IS NOT NULL
            "#,
        )
        .bind(bay_id)
        .fetch_all(pool)
        .await?;

        let mut sent = 0u64;
        for (token, lock_id) in rows {
            let msg = PushMessage {
                to: &token,
                title: "Bay taken",
                body: &format!("Someone parked in bay {bay_id}. Rerouting to next best."),
                data: json!({
                    "type": "lock_taken",
                    "bay_id": bay_id,
                }),
                sound: Some("default"),
            };
            if let Err(e) = self.send(msg).await {
                tracing::warn!(error = ?e, bay_id, "expo push failed");
                continue;
            }
            sqlx::query("UPDATE locks SET taken_notified_at = now() WHERE id = $1::uuid")
                .bind(&lock_id)
                .execute(pool)
                .await?;
            sent += 1;
        }
        Ok(sent)
    }

    /// Locks about to expire — send a heads-up 3 minutes out.
    pub async fn notify_pre_expiry(&self, pool: &PgPool) -> Result<u64> {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            r#"
            SELECT u.push_token, l.id::text, l.bay_id
            FROM locks l
            JOIN users u ON u.id = l.user_id
            WHERE l.released_at IS NULL
              AND l.pre_expiry_notified_at IS NULL
              AND l.expires_at > now()
              AND l.expires_at <= now() + interval '3 minutes'
              AND u.push_token IS NOT NULL
            "#,
        )
        .fetch_all(pool)
        .await?;

        let mut sent = 0u64;
        for (token, lock_id, bay_id) in rows {
            let msg = PushMessage {
                to: &token,
                title: "Lock expiring soon",
                body: &format!("Your lock on bay {bay_id} expires in 3 min. Tap to extend."),
                data: json!({
                    "type": "lock_pre_expiry",
                    "bay_id": bay_id,
                }),
                sound: Some("default"),
            };
            if let Err(e) = self.send(msg).await {
                tracing::warn!(error = ?e, bay_id, "expo push failed");
                continue;
            }
            sqlx::query("UPDATE locks SET pre_expiry_notified_at = now() WHERE id = $1::uuid")
                .bind(&lock_id)
                .execute(pool)
                .await?;
            sent += 1;
        }
        Ok(sent)
    }
}

#[derive(Serialize)]
struct PushMessage<'a> {
    to: &'a str,
    title: &'a str,
    body: &'a str,
    #[serde(skip_serializing_if = "serde_json::Value::is_null")]
    data: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    sound: Option<&'a str>,
}
