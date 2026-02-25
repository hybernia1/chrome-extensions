const $ = (id) => document.getElementById(id);

function setRowView(state) {
  $("idx").textContent = state?.index != null ? String(state.index + 1) : "-";
  $("total").textContent = state?.total != null ? String(state.total) : "-";
  $("order").textContent = state?.orderNo || "-";
  $("invoice").textContent = state?.invoiceNo || "-";
}

$("start").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "START" });
  $("status").textContent = res?.ok ? "Start…" : (res?.error || "Chyba");
});

$("stop").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "STOP" });
  $("status").textContent = res?.ok ? "Stop." : (res?.error || "Chyba");
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "STATUS") $("status").textContent = msg.text;
  if (msg?.type === "ROW") setRowView(msg.state);
});

(async () => {
  const st = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (st?.ok) setRowView(st.state);
})();