const fs = require('fs');
const path = require('path');
const { isAuthenticated } = require('../lib/auth');

const htmlApp   = fs.readFileSync(path.join(__dirname, '../views/index.html'), 'utf8');
const htmlLogin = fs.readFileSync(path.join(__dirname, '../views/login.html'), 'utf8');

module.exports = async function(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(isAuthenticated(req) ? htmlApp : htmlLogin);
};
