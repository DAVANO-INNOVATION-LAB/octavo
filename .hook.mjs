import http from "node:http";
let got = [];
const s = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => { got.push(b); res.end("ok");
    console.log("WEBHOOK RECEIVED:", b.slice(0, 200)); });
});
s.listen(8599, () => console.log("webhook receiver on 8599"));
setTimeout(() => { console.log("total received:", got.length); process.exit(0); }, 30000);
