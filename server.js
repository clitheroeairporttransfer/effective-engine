const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.send('Clitheroe Airport Transfer API'));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
