use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("not found")]
    NotFound,
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("database error")]
    Database(#[from] sqlx::Error),
    #[error("redis error")]
    Redis(#[from] redis::RedisError),
    #[error("internal error: {0}")]
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, body) = match &self {
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".into()),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".into()),
            ApiError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            ApiError::Database(e) => {
                tracing::error!(error=?e, "db error");
                (StatusCode::INTERNAL_SERVER_ERROR, "database error".into())
            }
            ApiError::Redis(e) => {
                tracing::error!(error=?e, "redis error");
                (StatusCode::INTERNAL_SERVER_ERROR, "cache error".into())
            }
            ApiError::Internal(m) => {
                tracing::error!(error=%m, "internal");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
        };
        (status, Json(json!({ "error": body }))).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
