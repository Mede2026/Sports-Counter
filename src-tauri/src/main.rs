// Empêche l'ouverture d'une console noire derrière l'app en release sur Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sports_counter_lib::run()
}
