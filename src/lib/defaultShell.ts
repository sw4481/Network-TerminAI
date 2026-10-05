export function defaultShell() {
  if (navigator.platform.toLowerCase().includes("win")) return "powershell.exe";
  return "/bin/zsh";
}
