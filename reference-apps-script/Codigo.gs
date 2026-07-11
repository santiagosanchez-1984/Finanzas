// ============================================================
// Finanzas Personales — Google Apps Script
// Spreadsheet: 148O0IDtQ8xOmt02W-hXhNDzmoiLoztQG8IohLVrK51Y
// ============================================================

var SS_ID = '148O0IDtQ8xOmt02W-hXhNDzmoiLoztQG8IohLVrK51Y';

// ─── Web App ─────────────────────────────────────────────────

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Finanzas Personales')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─── Helpers de hoja ─────────────────────────────────────────

function getSS() {
  return SpreadsheetApp.openById(SS_ID);
}

function getRegistroSheet() {
  var ss = getSS();
  var candidatos = ['REGISTRO', 'Registro', 'registro', 'Movimientos', 'Transacciones'];
  for (var i = 0; i < candidatos.length; i++) {
    var h = ss.getSheetByName(candidatos[i]);
    if (h) return h;
  }
  // Buscar por encabezado: primera hoja que tenga "Fecha" en A1
  var sheets = ss.getSheets();
  for (var j = 0; j < sheets.length; j++) {
    if (sheets[j].getLastRow() > 1) {
      var cell = sheets[j].getRange(1,1).getDisplayValue().toLowerCase();
      if (cell.indexOf('fecha') >= 0) return sheets[j];
    }
  }
  return ss.getSheets()[0];
}

function getPresupuestoSheet() {
  var ss = getSS();
  var candidatos = ['METAS Y PRESUPUESTO','PRESUPUESTO','Presupuesto','Metas'];
  for (var i = 0; i < candidatos.length; i++) {
    var h = ss.getSheetByName(candidatos[i]);
    if (h) return h;
  }
  return null;
}

// ─── Lectura principal ────────────────────────────────────────

function leerTodas() {
  var hoja = getRegistroSheet();
  var lr   = hoja.getLastRow();
  if (lr < 2) return [];
  var data = hoja.getRange(2, 1, lr - 1, 10).getDisplayValues();
  return data
    .filter(function(r) { return r[0] && r[5]; })
    .map(function(r) {
      return {
        fecha:       r[0].trim(),
        tipo:        r[1].trim(),
        categoria:   r[2].trim(),
        subcat:      r[3].trim(),
        descripcion: r[4].trim(),
        monto:       parseMonto(r[5]),
        medioPago:   r[6].trim(),
        mes:         r[7].trim(),
        notas:       r[8].trim(),
        banco:       r[9].trim()
      };
    });
}

function parseMonto(str) {
  if (!str) return 0;
  var s = String(str).replace(/[$\s]/g,'').replace(/\./g,'').replace(',','.');
  return parseFloat(s) || 0;
}

function fechaToMes(fecha) {
  if (!fecha) return '';
  var m = fecha.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + String(m[2]).padStart(2,'0');
  var m2 = fecha.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return m2[1] + '-' + m2[2];
  return '';
}

function fmtMonto(n) {
  return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.');
}

// ─── Dashboard ───────────────────────────────────────────────

function getDashboardData(anio, mes, banco, cat, subcat) {
  var rows = leerTodas();
  if (anio)   rows = rows.filter(function(r) { return r.mes && r.mes.startsWith(anio); });
  if (mes)    rows = rows.filter(function(r) { return r.mes === mes; });
  if (banco)  rows = rows.filter(function(r) { return r.banco === banco; });
  if (cat)    rows = rows.filter(function(r) { return r.categoria === cat; });
  if (subcat) rows = rows.filter(function(r) { return r.subcat === subcat; });

  var ingresos = 0, egresos = 0;
  var porMes = {}, porCatEgreso = {}, porCatIngreso = {}, porBanco = {};
  // clave: "categoria|subcat" para distinguir subcats iguales de distintas cats
  var porSubcatMes = {};

  rows.forEach(function(r) {
    var m = r.monto;
    if (r.tipo === 'INGRESO') {
      ingresos += m;
      porCatIngreso[r.categoria] = (porCatIngreso[r.categoria] || 0) + m;
    } else if (r.tipo === 'EGRESO') {
      egresos += m;
      porCatEgreso[r.categoria] = (porCatEgreso[r.categoria] || 0) + m;
      // Acumular subcategoría por mes
      if (r.mes) {
        var scKey = r.categoria + '|' + (r.subcat || 'Sin subcat');
        if (!porSubcatMes[r.mes]) porSubcatMes[r.mes] = {};
        porSubcatMes[r.mes][scKey] = (porSubcatMes[r.mes][scKey] || 0) + m;
      }
    }
    if (r.mes) {
      if (!porMes[r.mes]) porMes[r.mes] = {ing: 0, egr: 0};
      if (r.tipo === 'INGRESO') porMes[r.mes].ing += m;
      if (r.tipo === 'EGRESO')  porMes[r.mes].egr += m;
    }
    if (r.banco) porBanco[r.banco] = (porBanco[r.banco] || 0) + 1;
  });

  var balance   = ingresos - egresos;
  var pctAhorro = ingresos > 0 ? Math.round(balance / ingresos * 1000) / 10 : 0;
  var recientes = rows.slice(-15).reverse();

  return JSON.stringify({
    ingresos:      ingresos,
    egresos:       egresos,
    balance:       balance,
    pctAhorro:     pctAhorro,
    total:         rows.length,
    porMes:        porMes,
    porCatEgreso:  porCatEgreso,
    porCatIngreso: porCatIngreso,
    porBanco:      porBanco,
    porSubcatMes:  porSubcatMes,
    recientes:     recientes
  });
}

// ─── Movimientos ─────────────────────────────────────────────

function getMovimientos(filtrosJson) {
  var f    = JSON.parse(filtrosJson || '{}');
  var rows = leerTodas();

  if (f.mes)      rows = rows.filter(function(r){ return r.mes === f.mes; });
  if (f.banco)    rows = rows.filter(function(r){ return r.banco === f.banco; });
  if (f.tipo)     rows = rows.filter(function(r){ return r.tipo === f.tipo; });
  if (f.categoria)rows = rows.filter(function(r){ return r.categoria === f.categoria; });
  if (f.texto)    rows = rows.filter(function(r){
    return r.descripcion.toLowerCase().indexOf(f.texto.toLowerCase()) >= 0 ||
           r.medioPago.toLowerCase().indexOf(f.texto.toLowerCase()) >= 0;
  });

  // Ordenar más reciente primero (DD/MM/YYYY)
  rows.sort(function(a, b) {
    var da = a.fecha.split('/').reverse().join('');
    var db = b.fecha.split('/').reverse().join('');
    return db > da ? 1 : db < da ? -1 : 0;
  });

  return JSON.stringify({rows: rows, total: rows.length});
}

function getMetadatos() {
  var rows = leerTodas();
  var meses = {}, bancos = {}, cats = {}, tipos = {}, subcats = {};
  rows.forEach(function(r) {
    if (r.mes)      meses[r.mes]      = true;
    if (r.banco)    bancos[r.banco]   = true;
    if (r.categoria)cats[r.categoria] = true;
    if (r.tipo)     tipos[r.tipo]     = true;
    if (r.subcat)   subcats[r.subcat] = true;
  });
  return JSON.stringify({
    meses:   Object.keys(meses).sort().reverse(),
    bancos:  Object.keys(bancos).sort(),
    cats:    Object.keys(cats).sort(),
    tipos:   Object.keys(tipos).sort(),
    subcats: Object.keys(subcats).sort()
  });
}

// Devuelve mapa de claves de dedup para que el frontend filtre antes de importar
function getExistentes() {
  var hoja = getRegistroSheet();
  var lr   = hoja.getLastRow();
  if (lr < 2) return JSON.stringify({});
  var data = hoja.getRange(2, 1, lr - 1, 6).getValues();
  var keys = {};
  data.forEach(function(r) {
    var fechaRaw = r[0], desc = String(r[4] || '').trim(), montoRaw = r[5];
    if (!fechaRaw || !desc) return;
    var monto = typeof montoRaw === 'number' ? montoRaw : parseMonto(String(montoRaw));
    var k = claveDuplicado(fechaRaw, desc, monto);
    keys[k] = true;
  });
  return JSON.stringify(keys);
}

// ─── Importar ─────────────────────────────────────────────────

function importarMovimientos(rowsJson, banco) {
  var rows = JSON.parse(rowsJson);
  if (!rows || rows.length === 0) return JSON.stringify({ok: false, msg: 'Sin datos'});

  var hoja = getRegistroSheet();
  var lr   = hoja.getLastRow();

  // Construir mapa de duplicados: fecha normalizada | descripcion[0:35] | monto
  var existentes = {};
  if (lr >= 2) {
    // getValues() retorna el valor crudo: Date si Sheets convirtió, string si quedó como texto
    var existRaw = hoja.getRange(2, 1, lr - 1, 6).getValues();
    existRaw.forEach(function(r) {
      var fechaRaw = r[0], montoRaw = r[5], desc = String(r[4] || '').trim();
      if (!fechaRaw || !desc) return;
      var monto = typeof montoRaw === 'number' ? montoRaw : parseMonto(String(montoRaw));
      var k = claveDuplicado(fechaRaw, desc, monto); // claveDuplicado acepta Date o string
      existentes[k] = true;
    });
  }

  var nuevas = [];
  rows.forEach(function(row) {
    var monto = Math.abs(row.monto);
    var k     = claveDuplicado(row.fecha, row.descripcion, monto);
    if (existentes[k]) return;
    existentes[k] = true;
    var mes = fechaToMes(row.fecha);
    nuevas.push([
      row.fecha,
      row.tipo        || 'EGRESO',
      row.categoria   || 'Otros Gastos',
      row.subcat      || '',
      (row.descripcion || '').substring(0, 200),
      fmtMonto(monto),
      row.medioPago   || banco,
      mes,
      'Importado ' + banco,
      banco
    ]);
  });

  if (nuevas.length > 0) {
    var firstRow = lr + 1;
    // Forzar texto en col A ANTES de escribir — así Sheets no auto-convierte a Date
    hoja.getRange(firstRow, 1, nuevas.length, 1).setNumberFormat('@');
    hoja.getRange(firstRow, 1, nuevas.length, 10).setValues(nuevas);
  }

  return JSON.stringify({
    ok:        true,
    importadas: nuevas.length,
    duplicadas: rows.length - nuevas.length
  });
}

function claveDuplicado(fecha, desc, monto) {
  // Acepta Date objects (cuando Sheets auto-convierte), strings DD/MM/YYYY, D/M/YYYY, YYYY-MM-DD
  var fechaNorm;
  if (fecha instanceof Date) {
    fechaNorm = fecha.getFullYear() +
                String(fecha.getMonth() + 1).padStart(2, '0') +
                String(fecha.getDate()).padStart(2, '0');
  } else {
    var f = String(fecha).trim();
    var mf = f.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (mf) {
      fechaNorm = mf[3] + String(mf[2]).padStart(2,'0') + String(mf[1]).padStart(2,'0');
    } else {
      var mf2 = f.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      fechaNorm = mf2 ? mf2[1] + mf2[2] + mf2[3] : f.replace(/[\/\-\s]/g,'');
    }
  }
  return fechaNorm + '|' + String(desc).trim().substring(0,35).toLowerCase() + '|' + Math.round(Math.abs(monto));
}

// ─── Limpieza de duplicados (ejecutar UNA VEZ desde el editor) ──
function limpiarDuplicados() {
  var hoja = getRegistroSheet();
  var lr   = hoja.getLastRow();
  if (lr < 3) return JSON.stringify({ok: true, eliminadas: 0});

  var data = hoja.getRange(2, 1, lr - 1, 6).getValues();
  var vistos = {};
  var filasABorrar = [];

  data.forEach(function(r, i) {
    var desc     = String(r[4] || '').trim();
    var montoRaw = r[5];
    if (!desc) return;
    var monto = typeof montoRaw === 'number' ? montoRaw : parseMonto(String(montoRaw));
    // Clave sin fecha: evita problemas de Date vs string en celdas ya importadas
    // desc[0:40] + monto identifica transacciones exactamente iguales
    var k = desc.substring(0, 40).toLowerCase() + '|' + Math.round(Math.abs(monto));
    if (vistos[k]) {
      filasABorrar.push(i + 2); // fila en la hoja (data[0] = hoja fila 2)
    } else {
      vistos[k] = true;
    }
  });

  for (var j = filasABorrar.length - 1; j >= 0; j--) {
    hoja.deleteRow(filasABorrar[j]);
  }
  return JSON.stringify({ok: true, eliminadas: filasABorrar.length});
}

// ─── Presupuesto ─────────────────────────────────────────────

function getPresupuesto() {
  var hoja = getPresupuestoSheet();
  if (!hoja) return JSON.stringify([]);
  var lr = hoja.getLastRow();
  if (lr < 2) return JSON.stringify([]);
  var data = hoja.getRange(2, 1, lr - 1, 6).getDisplayValues();
  var result = data.filter(function(r){ return r[0] && r[1]; }).map(function(r) {
    return {
      categoria:   r[0],
      presupuesto: parseMonto(r[1]),
      gastado:     parseMonto(r[2]),
      diferencia:  parseMonto(r[3]),
      pctUsado:    r[4],
      estado:      r[5]
    };
  });
  return JSON.stringify(result);
}

// ─── Info de hojas (debug) ───────────────────────────────────

function getSheetNames() {
  var ss = getSS();
  return JSON.stringify(ss.getSheets().map(function(h){ return h.getName(); }));
}

// ─── Seguridad / Control de acceso ───────────────────────────

var OWNER_EMAIL   = 'santiago.hector.sanchez@gmail.com';
var TODOS_MODULOS = ['inicio','movimientos','importar','presupuesto','sueldos','evolucion','admin'];

function getAccesosSheet() {
  var ss   = getSS();
  var hoja = ss.getSheetByName('ACCESOS');
  if (!hoja) {
    hoja = ss.insertSheet('ACCESOS');
    var hdrs = [['Email','Nombre','Módulos','Activo','Fecha alta']];
    hoja.getRange(1, 1, 1, 5).setValues(hdrs)
        .setFontWeight('bold')
        .setBackground('#0A3560')
        .setFontColor('#ffffff');
    hoja.setColumnWidth(1, 240);
    hoja.setColumnWidth(3, 340);
  }
  return hoja;
}

function verificarAcceso() {
  var email = Session.getActiveUser().getEmail();
  var effectiveEmail = Session.getEffectiveUser().getEmail();
  if (!email) {
    var diagMsg = 'No se pudo identificar tu cuenta Google.';
    if (effectiveEmail && effectiveEmail !== '') {
      diagMsg += ' [DIAG: script corre como "' + effectiveEmail + '" — el deployment sigue en modo "Execute as: Me". Cambialo a "User accessing the web app" y redesplegá.]';
    } else {
      diagMsg += ' [DIAG: active="", effective="". El usuario no está logueado en Google o no autorizó el script.]';
    }
    return JSON.stringify({ ok: false, msg: diagMsg });
  }
  if (email.toLowerCase() === OWNER_EMAIL.toLowerCase()) {
    return JSON.stringify({ ok: true, email: email, nombre: 'Santiago', modulos: TODOS_MODULOS });
  }
  var hoja = getAccesosSheet();
  var lr   = hoja.getLastRow();
  if (lr < 2) return JSON.stringify({ ok: false, msg: 'No tenés acceso. Email detectado: ' + email });
  var data = hoja.getRange(2, 1, lr - 1, 4).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email.toLowerCase()) {
      // Soporta boolean true/false y strings "TRUE"/"FALSE"
      var activo = data[i][3];
      var estaActivo = (activo === true || String(activo).toLowerCase() === 'true');
      if (!estaActivo) return JSON.stringify({ ok: false, msg: 'Tu acceso está desactivado. Contactá al administrador.' });
      var mods = String(data[i][2]).split(',').map(function(m){ return m.trim(); }).filter(Boolean);
      return JSON.stringify({ ok: true, email: email, nombre: String(data[i][1]).trim() || email, modulos: mods });
    }
  }
  return JSON.stringify({ ok: false, msg: 'Email ' + email + ' no tiene acceso. Pedile al administrador que te habilite.' });
}

function getUsuarios() {
  var check = JSON.parse(verificarAcceso());
  if (!check.ok || check.modulos.indexOf('admin') < 0) return JSON.stringify([]);
  var hoja = getAccesosSheet();
  var lr   = hoja.getLastRow();
  if (lr < 2) return JSON.stringify([]);
  var data = hoja.getRange(2, 1, lr - 1, 5).getValues();
  return JSON.stringify(data.filter(function(r){ return r[0]; }).map(function(r) {
    return { email: String(r[0]), nombre: String(r[1]), modulos: String(r[2]), activo: !!r[3] };
  }));
}

function guardarUsuario(json) {
  var check = JSON.parse(verificarAcceso());
  if (!check.ok || check.modulos.indexOf('admin') < 0) return JSON.stringify({ ok: false, msg: 'Sin permisos de administrador' });
  var u    = JSON.parse(json);
  var hoja = getAccesosSheet();
  var lr   = hoja.getLastRow();
  if (lr >= 2) {
    var emails = hoja.getRange(2, 1, lr - 1, 1).getValues();
    for (var i = 0; i < emails.length; i++) {
      if (String(emails[i][0]).trim().toLowerCase() === u.email.trim().toLowerCase()) {
        hoja.getRange(i + 2, 1, 1, 4).setValues([[u.email, u.nombre, u.modulos, u.activo]]);
        return JSON.stringify({ ok: true, msg: 'Usuario actualizado' });
      }
    }
  }
  hoja.appendRow([u.email, u.nombre, u.modulos, u.activo, new Date()]);
  return JSON.stringify({ ok: true, msg: 'Usuario agregado' });
}

function eliminarUsuario(email) {
  var check = JSON.parse(verificarAcceso());
  if (!check.ok || check.modulos.indexOf('admin') < 0) return JSON.stringify({ ok: false });
  var hoja = getAccesosSheet();
  var lr   = hoja.getLastRow();
  if (lr < 2) return JSON.stringify({ ok: true });
  var emails = hoja.getRange(2, 1, lr - 1, 1).getValues();
  for (var i = emails.length - 1; i >= 0; i--) {
    if (String(emails[i][0]).trim().toLowerCase() === email.trim().toLowerCase()) {
      hoja.deleteRow(i + 2);
      break;
    }
  }
  return JSON.stringify({ ok: true });
}