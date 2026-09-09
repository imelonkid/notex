// Windows 的发布版不要拉起控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    notex_lib::run()
}
