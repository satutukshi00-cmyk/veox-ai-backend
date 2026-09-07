const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "VEOX AI Backend is running 🚀"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "VEOX AI is healthy"
  });
});

app.listen(PORT, () => {
  console.log(`VEOX AI running on port ${PORT}`);
});
