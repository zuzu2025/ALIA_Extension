const params = new URLSearchParams(location.search);
const isSensitive = Boolean(params.get("url"));

if (isSensitive) {
  document.title = "Suspended - Secure Site";
  document.getElementById("mode-label").textContent = "Alia secure suspension";
  document.getElementById("headline").textContent = "Suspended - Secure Site";
  document.getElementById("description").textContent = "Select restore to reload this site securely.";
}

document.getElementById("restore").addEventListener("click", () => {
  const originalUrl = params.get("url");
  if (/^https?:\/\//i.test(originalUrl || "")) location.replace(originalUrl);
});
