const tokenInput = document.getElementById("token");
const portInput = document.getElementById("port");
const status = document.getElementById("status");

browser.storage.local.get(["token", "port"]).then(({ token, port }) => {
  tokenInput.value = token || "";
  portInput.value = port || 8765;
});

document.getElementById("save").addEventListener("click", async () => {
  const port = Number(portInput.value) || 8765;
  await browser.storage.local.set({ token: tokenInput.value.trim(), port });
  status.textContent = "Salvo. Reconectando...";
  setTimeout(() => (status.textContent = ""), 3000);
});
