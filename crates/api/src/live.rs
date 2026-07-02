#![allow(clippy::collapsible_if, clippy::collapsible_match)]

use std::collections::HashSet;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/live", get(upgrade))
}

/// Event pushed to WS clients when a bay's sensor status changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SensorEvent {
    pub bay_id: String,
    pub status: String,
    pub source_updated_at: String,
}

#[derive(Debug, Deserialize)]
struct ClientMessage {
    subscribe: Option<Vec<String>>,
    unsubscribe: Option<Vec<String>>,
}

async fn upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle(socket, state.events.clone()))
}

async fn handle(socket: WebSocket, events: broadcast::Sender<SensorEvent>) {
    let (mut tx, mut rx) = socket.split();
    let mut subscription = events.subscribe();
    let mut interested: HashSet<String> = HashSet::new();

    loop {
        tokio::select! {
            client_msg = rx.next() => {
                match client_msg {
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(msg) = serde_json::from_str::<ClientMessage>(&t) {
                            if let Some(add) = msg.subscribe { interested.extend(add); }
                            if let Some(rm) = msg.unsubscribe { for r in rm { interested.remove(&r); } }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(p))) => {
                        if tx.send(Message::Pong(p)).await.is_err() { break; }
                    }
                    _ => {}
                }
            }
            event = subscription.recv() => {
                match event {
                    Ok(ev) if interested.contains(&ev.bay_id) => {
                        let payload = serde_json::to_string(&ev).unwrap_or_default();
                        if tx.send(Message::Text(payload)).await.is_err() { break; }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Client can't keep up. Drop them; they'll reconnect.
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

/// Runs in the API process, subscribing to Redis pubsub and republishing to
/// the local broadcast channel that WS handlers listen on.
pub async fn spawn_redis_bridge(
    redis_client: redis::Client,
    events: broadcast::Sender<SensorEvent>,
) {
    tokio::spawn(async move {
        loop {
            match redis_bridge_once(&redis_client, &events).await {
                Ok(()) => tracing::warn!("redis bridge exited cleanly, reconnecting"),
                Err(e) => tracing::error!(error = ?e, "redis bridge error"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

async fn redis_bridge_once(
    redis_client: &redis::Client,
    events: &broadcast::Sender<SensorEvent>,
) -> anyhow::Result<()> {
    let mut pubsub = redis_client.get_async_pubsub().await?;
    pubsub.psubscribe("bay:*").await?;
    let mut stream = pubsub.on_message();

    #[derive(Deserialize)]
    struct Payload {
        status: String,
        source_updated_at: String,
    }

    while let Some(msg) = stream.next().await {
        let channel: String = msg.get_channel_name().to_string();
        let bay_id = channel.strip_prefix("bay:").unwrap_or(&channel).to_string();
        let raw: String = match msg.get_payload() {
            Ok(s) => s,
            Err(_) => continue,
        };
        let Ok(p) = serde_json::from_str::<Payload>(&raw) else {
            continue;
        };
        let _ = events.send(SensorEvent {
            bay_id,
            status: p.status,
            source_updated_at: p.source_updated_at,
        });
    }
    Ok(())
}
