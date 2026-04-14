require("dotenv").config();

const express = require("express");
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "RoofSealing server is running" });
});

app.post("/webhook/zap1", (req, res) => {
  res.json({ status: "received" });
});

app.post("/webhook/zap2", (req, res) => {
  res.json({ status: "received" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

module.exports = { app };
