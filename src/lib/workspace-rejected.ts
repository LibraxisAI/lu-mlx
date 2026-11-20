/**
 * Der Satz fuer einen Arbeitsordner, den die Rust-Seite nicht annimmt.
 *
 * Seit 2.6.8 prueft `validate_workspace_root` (src-tauri/.../filesystem.rs)
 * jeden gesetzten Ordner gegen eine Verbotsliste: $HOME genau, `/`, `/etc`,
 * `/usr`, `~/.ssh`, `C:\Windows` und Geschwister. Auf v2.6.7 gab es diese
 * Pruefung nicht, dort nahm der Fernauftrag jeden nicht-leeren Pfad.
 *
 * Bis zum 04.09.2026 fing die Oberflaeche die Ablehnung mit einem leeren
 * `catch` und schickte den Auftrag trotzdem los. Der Satz hier ist die eine
 * Haelfte der Reparatur, die andere steht im Aufrufer: eine alte Bindung wird
 * geraeumt, statt stehen zu bleiben.
 *
 * Er ist eine eigene Funktion und keine Zeichenkette im Aufrufer, damit sein
 * Wortlaut pruefbar ist. Ohne Renderer im Testlauf waere er sonst die einzige
 * Stelle dieser Reparatur, die niemand messen kann.
 */
/**
 * Der Grund aus einem geworfenen Ding. `backendCall` wirft nicht immer ein
 * Error. Ein roher String muss genauso durchkommen wie eine Message, sonst
 * steht am Ende "undefined" im Satz.
 */
function grundText(fehler: unknown): string {
  return fehler instanceof Error ? fehler.message
    : typeof fehler === 'string' ? fehler
      : String(fehler)
}

export function workspaceRejectedMessage(pfad: string, fehler: unknown): string {
  return (
    `Cannot use "${pfad}" as the workspace: ${grundText(fehler)}. `
    + `Nothing was started, and no folder is bound to the remote session. `
    + `Pick a project folder instead of a system or home directory.`
  )
}

/**
 * Derselbe Fall eine Stufe frueher: der NATIVE DIALOG hat einen Ordner
 * geliefert, den die Rust-Seite nicht als Arbeitsordner annimmt, und
 * `pick_folder` meldet das seit Fehler D (08.09.2026) mit
 * `asWorkspace`, statt den Pfad auszuliefern, als waere nichts gewesen.
 *
 * Eigener Satz und nicht `workspaceRejectedMessage`: dort steht "no folder is
 * bound to the remote session", und der Code-Reiter hat keine Fernsitzung. Der
 * Pfad steht hier auch nicht drin: bei einem Fehler gibt der Dialog keinen
 * zurueck, und ein erfundener waere schlimmer als keiner. Der Ordner bleibt in
 * diesem Fall UNGESETZT, das ist die eigentliche Reparatur: ein abgelehnter
 * Ordner in der Kopfzeile beantwortet jede spaetere Dateioperation mit
 * "pick it again to allow it", also genau mit dem, was der Nutzer gerade getan
 * hat.
 */
export function workspacePickRefusedMessage(fehler: unknown): string {
  return (
    `That folder cannot be the workspace: ${grundText(fehler)}. `
    + `The folder was not taken. `
    + `Pick a project folder, not a drive root, a home directory or a system folder.`
  )
}

/**
 * Derselbe Fall ohne jeden Dialog: ein Ordner, den die Oberflaeche sich
 * GEMERKT hat, wird gesetzt, und die Rust-Seite nimmt ihn nicht an.
 *
 * Drei Wege tun das: der Knopf "Use last folder", der Vorgabeordner aus den
 * Einstellungen, und `codexStore.workingDirectory` (der Code-Reiter-Ordner
 * selbst), alle drei ueber den Speicher des Browsers und einen Neustart
 * hinweg. Eine frische Installation, geleerte Daten oder ein Ordner direkt
 * unter `$HOME` fuehren dort in dieselbe Sackgasse wie Fehler D, nur ohne
 * Dialog, also ohne Weg heraus.
 *
 * Der Pfad steht hier DRIN, anders als bei `workspacePickRefusedMessage`: der
 * Nutzer hat ihn nicht gerade ausgesucht, er liegt Wochen zurueck, und ohne
 * den Namen weiss niemand, welcher Ordner gemeint ist. Der Grund kommt roh von
 * der Rust-Seite und sagt je nach Fall selbst, ob ein neuer Griff zum Dialog
 * helfen kann; dieser Satz haengt nichts an, was dem widersprechen koennte, er
 * nennt nur den Knopf, der den Dialog oeffnet.
 */
export function rememberedWorkspaceRefusedMessage(pfad: string, fehler: unknown): string {
  return (
    `Cannot use "${pfad}" as the workspace: ${grundText(fehler)}. `
    + `The folder was not taken. `
    + `Choose one with "Pick a folder…" instead.`
  )
}
