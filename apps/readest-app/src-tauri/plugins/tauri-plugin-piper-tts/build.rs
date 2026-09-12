const COMMANDS: &[&str] = &[
    "list_voices",
    "download_voice",
    "cancel_download",
    "delete_voice",
    "load_voice",
    "unload_voice",
    "synthesize",
    "stop",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
