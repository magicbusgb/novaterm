'use strict';
/**
 * Import / export CSV delle sessioni.
 * Accetta intestazioni in italiano o inglese e separatori , ; o TAB (rilevati automaticamente).
 */
const Papa = require('papaparse');

const ALIASES = {
  name: ['name', 'nome', 'session', 'sessione', 'label', 'etichetta', 'title', 'titolo'],
  host: ['host', 'hostname', 'ip', 'address', 'indirizzo', 'server', 'remote_host', 'remotehost'],
  port: ['port', 'porta', 'ssh_port'],
  username: ['username', 'user', 'utente', 'login', 'user_name', 'nomeutente'],
  password: ['password', 'pass', 'pwd', 'passwd', 'secret'],
  group: ['group', 'gruppo', 'folder', 'cartella', 'category', 'categoria', 'tag', 'env', 'environment'],
  type: ['type', 'tipo', 'protocol', 'protocollo'],
  privateKeyPath: ['key', 'private_key', 'privatekey', 'key_path', 'keyfile', 'identity', 'chiave', 'identity_file'],
  passphrase: ['passphrase', 'key_passphrase'],
  notes: ['notes', 'note', 'description', 'descrizione', 'comment', 'commento'],
  startupCommand: ['startup', 'startup_command', 'command', 'comando', 'comando_avvio'],
};

function canonical(header) {
  const h = String(header || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  for (const [key, list] of Object.entries(ALIASES)) if (list.includes(h)) return key;
  return null;
}

/** Supporta anche host nel formato user@host:port nella colonna host. */
function splitHost(row) {
  let host = row.host || '';
  if (host.includes('@') && !row.username) {
    const [u, h] = host.split('@');
    row.username = u; host = h;
  }
  const m = host.match(/^\[?([^\]]+?)\]?:(\d+)$/);
  if (m && !host.includes('::')) { host = m[1]; if (!row.port) row.port = m[2]; }
  row.host = host.trim();
  return row;
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const res = Papa.parse(text, { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim() });
  const headers = res.meta.fields || [];
  const mapping = {};
  for (const h of headers) { const c = canonical(h); if (c && !Object.values(mapping).includes(c)) mapping[h] = c; }
  const unknown = headers.filter((h) => !mapping[h]);

  const rows = [];
  const errors = [];
  res.data.forEach((raw, i) => {
    const row = {};
    for (const [h, key] of Object.entries(mapping)) {
      const v = raw[h];
      if (v !== undefined && v !== null && String(v).trim() !== '') row[key] = key === 'password' || key === 'passphrase' ? String(v) : String(v).trim();
    }
    splitHost(row);
    const type = (row.type || 'ssh').toLowerCase();
    if (type !== 'local' && !row.host) { errors.push({ line: i + 2, message: 'host mancante' }); return; }
    if (row.port && !/^\d+$/.test(row.port)) { errors.push({ line: i + 2, message: `porta non valida: ${row.port}` }); return; }
    row.type = type === 'local' ? 'local' : 'ssh';
    rows.push(row);
  });
  for (const e of res.errors || []) errors.push({ line: (e.row ?? 0) + 2, message: e.message });
  return { rows, errors, mapping, unknownColumns: unknown, delimiter: res.meta.delimiter };
}

function exportCsv(sessions, includePasswords) {
  const cols = ['name', 'group', 'type', 'host', 'port', 'username'];
  if (includePasswords) cols.push('password');
  cols.push('privateKeyPath', 'notes');
  return Papa.unparse({
    fields: cols.map((c) => (c === 'privateKeyPath' ? 'private_key' : c)),
    data: sessions.map((s) => cols.map((c) => s[c] ?? '')),
  });
}

const TEMPLATE = 'name,group,host,port,username,password,private_key,notes\n' +
  'Web 1,Produzione,192.168.1.10,22,root,SuperSegreta!,,Server nginx\n' +
  'DB principale,Produzione,db.example.com,2222,admin,,~/.ssh/id_ed25519,PostgreSQL\n' +
  'Raspberry,Casa,pi@raspberrypi.local:22,,,raspberry,,\n';

module.exports = { parseCsv, exportCsv, TEMPLATE };
