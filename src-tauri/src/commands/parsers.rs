use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;

#[derive(Debug, Deserialize)]
pub struct ParseArgs {
    pub vendor: String,
    pub platform: String,
    pub command: String,
    pub raw: String,
}

#[derive(Debug, Serialize)]
pub struct ParseResponse {
    pub parser: String,
    pub data: serde_json::Value,
    pub from_cache: bool,
}

#[tauri::command]
pub async fn parse_show(
    args: ParseArgs,
    state: State<'_, AppState>,
) -> Result<ParseResponse, String> {
    let cache = state.parser_cache.clone();
    let bridge = state.parser_bridge.clone();

    let key = cache.key(&args.vendor, &args.platform, &args.command, &args.raw);

    if let Some(hit) = cache.get(&key).map_err(|e| e.to_string())? {
        let data: serde_json::Value =
            serde_json::from_str(&hit.data_json).map_err(|e| e.to_string())?;
        return Ok(ParseResponse {
            parser: hit.parser,
            data,
            from_cache: true,
        });
    }

    let parsed = bridge
        .parse(&args.vendor, &args.platform, &args.command, &args.raw)
        .await
        .map_err(|e| e.to_string())?;

    let data_json = serde_json::to_string(&parsed.data).map_err(|e| e.to_string())?;
    cache
        .put(
            &key,
            &args.vendor,
            &args.platform,
            &args.command,
            &parsed.parser,
            &data_json,
        )
        .map_err(|e| e.to_string())?;

    Ok(ParseResponse {
        parser: parsed.parser,
        data: parsed.data,
        from_cache: false,
    })
}
