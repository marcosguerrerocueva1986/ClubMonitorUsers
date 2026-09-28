#!/usr/bin/env node
// Verificador de los interruptores maestros de notificaciones.
// Ejecutar desde la carpeta del proyecto:   node verificar_interruptores_notificaciones.js
//
// Falla (codigo de salida 1) si algun archivo de /api envia un push a
// representantes o un WhatsApp saltandose los interruptores. Conviene
// correrlo antes de subir cambios, sobre todo cuando se agregue una
// notificacion nueva.
const fs = require('fs'), path = require('path');
const dir = process.argv[2] || path.join(__dirname, 'api');
const archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const problemas = [];

for (const f of archivos) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');

  // 1) Push directo a OneSignal dirigido a representantes (solo se permite en _notificaciones.js)
  if (f !== '_notificaciones.js') {
    let i = -1;
    while ((i = src.indexOf('onesignal.com/api', i + 1)) !== -1) {
      const tramo = src.slice(i, i + 1200);
      if (/key:\s*'representante_id'/.test(tramo)) {
        const linea = src.slice(0, i).split('\n').length;
        problemas.push(`${f}:${linea} -> push a representantes enviado directo a OneSignal. Usa enviarPushRepresentantes() de _notificaciones.js.`);
      }
    }
  }

  // 2) Envio directo a Evolution API (WhatsApp)
  if (src.includes('/message/send')) {
    if (f === '_admin_partidos.js') {
      const envios = (src.match(/\/message\/send(Text|Media)/g) || []).length;
      const controles = (src.match(/whatsappRepresentantesActivo\(config\)/g) || []).length;
      if (controles < envios) problemas.push(`${f} -> hay ${envios} envios de WhatsApp pero solo ${controles} consultan el interruptor.`);
    } else if (!src.includes('notif_whatsapp_representantes')) {
      problemas.push(`${f} -> envia WhatsApp directo a Evolution API sin consultar notif_whatsapp_representantes. Usa enviarWhatsAppGrupo/Privado/Media de _admin_partidos.js.`);
    }
  }
}

// 3) La configuracion que reciben las funciones de WhatsApp debe traer el interruptor
const partidos = fs.readFileSync(path.join(dir, '_admin_partidos.js'), 'utf8');
const cargar = partidos.slice(partidos.indexOf('async function cargarConfig'), partidos.indexOf('function fechaCorta'));
if (!cargar.includes('notif_whatsapp_representantes') || !cargar.includes('notif_push_representantes')) {
  problemas.push('_admin_partidos.js -> cargarConfig() no selecciona notif_push_representantes / notif_whatsapp_representantes.');
}

if (problemas.length) {
  console.error('❌ Se encontraron envios que se saltan los interruptores:\n  - ' + problemas.join('\n  - '));
  process.exit(1);
}
console.log('✅ Interruptores respetados: ningun envio a representantes se salta el control (' + archivos.length + ' archivos revisados).');
