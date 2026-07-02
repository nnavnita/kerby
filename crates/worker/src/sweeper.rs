use anyhow::Result;
use sqlx::PgPool;

/// Reap locks whose expires_at has passed.
pub async fn sweep_locks(pool: &PgPool) -> Result<u64> {
    let n = sqlx::query(
        r#"
        UPDATE locks
        SET released_at = now(), release_reason = 'expired'
        WHERE released_at IS NULL AND expires_at <= now()
        "#,
    )
    .execute(pool)
    .await?
    .rows_affected();
    Ok(n)
}
