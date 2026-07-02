//! End-to-end HTTP tests. Requires a running Postgres+PostGIS (with our
//! schema migrated) and Redis. Reads DATABASE_URL and REDIS_URL from env
//! (defaulting to the docker-compose stack in this repo).

use std::sync::Arc;

use kerby_api::state::AppState;
use kerby_api::{build_router, live};
use reqwest::StatusCode;
use serde_json::json;

const DEFAULT_DB: &str = "postgres://kerby:kerby@localhost:5433/kerby";
const DEFAULT_REDIS: &str = "redis://localhost:6379";

async fn spawn_test_server() -> String {
    let db_url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_DB.into());
    let redis_url = std::env::var("TEST_REDIS_URL")
        .or_else(|_| std::env::var("REDIS_URL"))
        .unwrap_or_else(|_| DEFAULT_REDIS.into());

    let db = sqlx::PgPool::connect(&db_url).await.expect("connect db");
    let redis_client = redis::Client::open(redis_url).expect("redis client");

    let (events_tx, _) = tokio::sync::broadcast::channel::<live::SensorEvent>(64);

    let state = AppState {
        db,
        redis: redis_client,
        jwt_secret: Arc::new("integration-test-secret".to_string()),
        jwt_ttl_secs: 3600,
        events: events_tx,
    };

    let app = build_router(state, false);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });
    format!("http://{}", addr)
}

fn unique_email() -> String {
    format!("test-{}@example.com", uuid::Uuid::new_v4())
}

async fn signup(base: &str, email: &str) -> String {
    let resp = reqwest::Client::new()
        .post(format!("{}/auth/signup", base))
        .json(&json!({ "email": email, "password": "testtest123" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    resp.json::<serde_json::Value>()
        .await
        .unwrap()
        .get("token")
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn health_ok() {
    let base = spawn_test_server().await;
    let body = reqwest::get(format!("{}/health", base))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(body, "ok");
}

#[tokio::test]
async fn signup_and_login_returns_token() {
    let base = spawn_test_server().await;
    let email = unique_email();
    let token = signup(&base, &email).await;
    assert!(!token.is_empty());

    let login = reqwest::Client::new()
        .post(format!("{}/auth/login", &base))
        .json(&json!({ "email": &email, "password": "testtest123" }))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    let body: serde_json::Value = login.json().await.unwrap();
    assert!(body.get("token").and_then(|v| v.as_str()).is_some());
}

#[tokio::test]
async fn login_rejects_wrong_password() {
    let base = spawn_test_server().await;
    let email = unique_email();
    signup(&base, &email).await;

    let resp = reqwest::Client::new()
        .post(format!("{}/auth/login", &base))
        .json(&json!({ "email": &email, "password": "wrongpassword" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn signup_rejects_duplicate_email() {
    let base = spawn_test_server().await;
    let email = unique_email();
    signup(&base, &email).await;

    let resp = reqwest::Client::new()
        .post(format!("{}/auth/signup", &base))
        .json(&json!({ "email": &email, "password": "testtest123" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn bays_near_shape() {
    let base = spawn_test_server().await;
    let resp = reqwest::get(format!(
        "{}/bays/near?lat=-37.814&lng=144.963&radius_m=200&limit=3",
        base
    ))
    .await
    .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body.get("bays").and_then(|v| v.as_array()).is_some());
    assert!(body.get("count").is_some());
}

#[tokio::test]
async fn session_create_current_return_round_trip() {
    let base = spawn_test_server().await;
    let email = unique_email();
    let token = signup(&base, &email).await;
    let client = reqwest::Client::new();

    // Create.
    let create = client
        .post(format!("{}/sessions", &base))
        .bearer_auth(&token)
        .json(&json!({ "lat": -37.814, "lng": 144.963, "note": "test" }))
        .send()
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::OK);
    let created: serde_json::Value = create.json().await.unwrap();
    let session_id = created["id"].as_str().unwrap().to_string();

    // Current.
    let current = client
        .get(format!("{}/sessions/current", &base))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::OK);
    let cur: serde_json::Value = current.json().await.unwrap();
    assert_eq!(cur["id"].as_str().unwrap(), session_id);

    // Return.
    let ret = client
        .post(format!("{}/sessions/{}/return", &base, session_id))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(ret.status(), StatusCode::OK);
    let returned: serde_json::Value = ret.json().await.unwrap();
    assert!(returned["returned_at"].as_str().is_some());
}

#[tokio::test]
async fn lock_create_release_flow() {
    let base = spawn_test_server().await;
    let email = unique_email();
    let token = signup(&base, &email).await;
    let client = reqwest::Client::new();

    // Grab any bay id from the DB via /bays/near.
    let near: serde_json::Value = reqwest::get(format!(
        "{}/bays/near?lat=-37.814&lng=144.963&radius_m=500&limit=1",
        base
    ))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let bay_id = near["bays"][0]["id"]
        .as_str()
        .expect("bays table has at least one bay near CBD centre")
        .to_string();

    // Lock.
    let lock_resp = client
        .post(format!("{}/locks", &base))
        .bearer_auth(&token)
        .json(&json!({ "bay_id": &bay_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(lock_resp.status(), StatusCode::OK);
    let lock: serde_json::Value = lock_resp.json().await.unwrap();
    let lock_id = lock["id"].as_str().unwrap().to_string();

    // Current lock returns it.
    let current = client
        .get(format!("{}/locks/current", &base))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::OK);
    let cur: serde_json::Value = current.json().await.unwrap();
    assert_eq!(cur["id"].as_str().unwrap(), lock_id);

    // Second lock same user → 409.
    let dup = client
        .post(format!("{}/locks", &base))
        .bearer_auth(&token)
        .json(&json!({ "bay_id": &bay_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(dup.status(), StatusCode::CONFLICT);

    // Release.
    let release = client
        .delete(format!("{}/locks/{}", &base, lock_id))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(release.status(), StatusCode::OK);
}

#[tokio::test]
async fn destination_crud() {
    let base = spawn_test_server().await;
    let email = unique_email();
    let token = signup(&base, &email).await;
    let client = reqwest::Client::new();

    let create = client
        .post(format!("{}/destinations", &base))
        .bearer_auth(&token)
        .json(&json!({
            "name": "Home",
            "lat": -37.814,
            "lng": 144.963,
            "walk_radius_m": 250
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::OK);
    let created: serde_json::Value = create.json().await.unwrap();
    let dest_id = created["id"].as_str().unwrap().to_string();

    let list = client
        .get(format!("{}/destinations", &base))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::OK);
    let items: serde_json::Value = list.json().await.unwrap();
    assert_eq!(items.as_array().unwrap().len(), 1);

    let del = client
        .delete(format!("{}/destinations/{}", &base, dest_id))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), StatusCode::OK);
}

#[tokio::test]
async fn legal_pages_render_html() {
    let base = spawn_test_server().await;
    for path in ["/legal/terms", "/legal/privacy"] {
        let resp = reqwest::get(format!("{}{}", base, path)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "{}", path);
        let ct = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(ct.starts_with("text/html"), "{}: {}", path, ct);
    }
}
