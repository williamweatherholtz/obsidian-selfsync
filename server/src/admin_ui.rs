use axum::response::Html;

// The web admin UI — a self-contained page (inline CSS/JS, no external requests) served
// same-origin over the sync API's TLS. It authenticates via /api/login and drives the
// /api/admin/* JSON authority; it stores no truth of its own.
pub async fn page() -> Html<&'static str> {
    Html(include_str!("admin_ui.html"))
}
