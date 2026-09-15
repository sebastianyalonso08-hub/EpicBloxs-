from pathlib import Path
p=Path('/mnt/data/v53work/public/index.html')
s=p.read_text(encoding='utf-8')
s=s.replace('<html lang="es">','<html lang="en">',1)
old='''    <div class="setting-row"><span>Sunnys</span><strong id="settingsMoney">500</strong> ☀️</div>\n'''
new=old+'''    <div class="setting-row"><span data-i18n="Language">Language</span><select id="languageSelect" onchange="setSiteLanguage(this.value)" style="padding:8px;width:180px;border:1px solid #ccc;border-radius:5px"><option value="en">English</option><option value="es">Español</option></select></div>\n'''
if old not in s: raise SystemExit('settings anchor not found')
s=s.replace(old,new,1)
marker='''</html>\n\n(function(){ const m=location.pathname.match(/^\\/perfil\\/(\\d+)$/); if(m){ setTimeout(()=>openUserProfile(m[1]),0); } })();'''
js=r'''<script>
/* ===== EpicBloxs language system =====
   English is the default. The choice is stored locally and survives reloads.
   The translator keeps the original text so switching between English/Spanish
   does not damage dynamic UI strings. */
(function(){
  const LANG_KEY='epicbloxs_language';
  const translations={
    'es':{
      'Games':'Juegos','Catalog':'Catálogo','Friends':'Amigos','Create':'Crear','Download':'Descargar','Home':'Inicio','Profile':'Perfil','Avatar':'Avatar','Inventory':'Inventario','Racha':'Racha','Settings':'Configuración','Trade':'Intercambio','See All':'Ver todo','Show More':'Mostrar más',
      'Recently Played':'Jugados recientemente','Discover unique games created by the community.':'Descubre juegos únicos creados por la comunidad.','Edit Avatar':'Editar avatar','Account':'Cuenta','Language':'Idioma','Sunnys':'Sunnys','Themes':'Temas','Light':'Claro','Dark':'Oscuro','Blue':'Azul','Purple':'Morado','Description':'Descripción','Save Description':'Guardar descripción','Reset local data':'Restablecer datos locales','Reset':'Restablecer','Edit':'Editar',
      'Settings':'Configuración','Avatar Preview.':'Vista previa del avatar.','Avatar Prewiew.':'Vista previa del avatar.','Personalization Accesories and Clothing':'Personalización, accesorios y ropa','Equip or unequip accesories that you own! [W.I.P]:':'¡Equipa o desequipa los accesorios que tienes! [EN PROGRESO]','Remove all':'Quitar todo','Quitar todo':'Quitar todo','Torso Type':'Tipo de torso','Tipo de Torso':'Tipo de torso','Male (Default)':'Hombre (predeterminado)','♂ Hombre (Default)':'♂ Hombre (predeterminado)','Female':'Mujer','♀ Mujer':'♀ Mujer','Head Color':'Color de cabeza','Arms Color':'Color de brazos','Torso Color':'Color de torso','Legs Color':'Color de piernas',
      'Here are your clothing, accessories, faces and other avatar items.':'Aquí están tu ropa, accesorios, caras y otros artículos del avatar.','Los objetos de una partida aparecen solo dentro del juego y no se mezclan con este inventario.':'Los objetos de una partida aparecen solo dentro del juego y no se mezclan con este inventario.',
      'Daily Streak':'Racha diaria','Racha de Sunnys':'Racha de Sunnys','Current streak':'Racha actual','Racha actual':'Racha actual','Today\'s reward':'Recompensa de hoy','Recompensa de hoy':'Recompensa de hoy','Next Reward':'Próxima recompensa','Last Claim':'Último reclamo','Never':'Nunca','Nunca':'Nunca','Claim today\'s streak':'Reclamar racha de hoy','Reclamar racha de hoy':'Reclamar racha de hoy','Each consecutive day you log in, your streak increases and you receive more Sunnys.':'Cada día consecutivo que inicies sesión, tu racha aumenta y recibes más Sunnys.',
      'Verify with Discord':'Verificar con Discord','Join Discord':'Unirse al Discord','Unirse al Discord':'Unirse al Discord','Avatar':'Avatar','Catalog':'Catálogo','Buy':'Comprar','Comprar':'Comprar','Equip':'Equipar','Equipar': 'Equipar','Unequip':'Quitar','Quitar':'Quitar','Equipped':'Equipado','Equipado':'Equipado','You have no items to offer.':'No tienes artículos para ofrecer.','No description available.':'No hay descripción disponible.',
      'Write a description about yourself...':'Escribe una descripción sobre ti...','Escribe una descripción sobre ti...':'Escribe una descripción sobre ti...','Search':'Buscar','Search users':'Buscar usuarios','Send':'Enviar','Cancel':'Cancelar','Aceptar':'Aceptar','Reject':'Rechazar','Rechazar':'Rechazar','Back to Friends':'Volver a Amigos','Volver a Friends':'Volver a Amigos','Online':'En línea','Offline':'Desconectado','En linea':'En línea','Desconectado':'Desconectado','Playing':'Jugando','Jugando':'Jugando',
      'Sala del juego':'Sala del juego','Direct Chat':'Chat directo','Groups':'Grupos','Sistema: Entra a un juego para chatear en tiempo real con otros jugadores.':'Sistema: Entra a un juego para chatear en tiempo real con otros jugadores.','Escribe un mensaje...':'Escribe un mensaje...','Trade Sunnys, clothing and accessories with your friends.':'Intercambia Sunnys, ropa y accesorios con tus amigos.','Sunnys que das':'Sunnys que das','No se pudo conectar con el servidor.':'No se pudo conectar con el servidor.',
      'Description':'Descripción','Users':'Usuarios','Posts':'Publicaciones','Update':'Actualizar','Kick':'Expulsar','Ban':'Bloquear','Reason':'Motivo','Volar ON/OFF':'Volar ON/OFF','Regalar':'Regalar','Darme Sunnys':'Darme Sunnys','Actualizar':'Actualizar','Motivo (kick/ban)':'Motivo (kick/ban)',
      'Herramienta':'Herramienta','Lapiz':'Lápiz','Goma':'Borrador','Linea':'Línea','Rectangulo':'Rectángulo','Circulo':'Círculo','Relleno':'Relleno','Accountgotas':'Cuentagotas','Texto':'Texto','Deshacer':'Deshacer','Rehacer':'Rehacer','Limpiar':'Limpiar','Descargar plantilla camiseta':'Descargar plantilla de camiseta','Descargar plantilla pantalon':'Descargar plantilla de pantalón','Descripcion':'Descripción','Camisa':'Camisa','Pantalon':'Pantalón','Cara':'Cara','Sombrero':'Sombrero','Publicado en el catalogo.':'Publicado en el catálogo.','Debes iniciar sesión.':'Debes iniciar sesión.','Pon un nombre a la ropa.':'Ponle un nombre a la ropa.','Precio':'Precio',
      'Volver a Games':'Volver a Juegos','Games':'Juegos','Play':'Jugar','Jugar':'Jugar','Loading':'Cargando','Cargando':'Cargando','Exit':'Salir','Salir':'Salir','Menu':'Menú','Menú':'Menú','Inventory':'Inventario','Backpack':'Mochila',
      'English':'Inglés','Español':'Español'
    }
  };
  const protectedSelectors=['#chatBody','#dmMessages','#groupMessages','#profileBio','#bioEditor','#creatorName','#creatorDescription','#chatInput','#dmInput','#groupMessageInput','#userSearchInput','#friendSearchInput'];
  function isProtected(el){ return el && protectedSelectors.some(sel=>el.closest && el.closest(sel)); }
  function trText(text,lang){
    const t=String(text||''); if(!t.trim()) return t;
    if(lang==='en'){
      const es=translations.es;
      for(const [en,esv] of Object.entries(es)) if(t.trim()===esv) return t.replace(t.trim(),en);
      return t;
    }
    const es=translations.es;
    const exact=es[t.trim()]; if(exact!==undefined) return t.replace(t.trim(),exact);
    return t;
  }
  function walk(root,lang){
    if(!root) return;
    const nodes=[];
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    let n; while(n=walker.nextNode()) nodes.push(n);
    nodes.forEach(node=>{
      const el=node.parentElement; if(!el || isProtected(el) || ['SCRIPT','STYLE','NOSCRIPT'].includes(el.tagName)) return;
      if(node.parentElement && node.parentElement.closest('[data-no-i18n]')) return;
      if(!node.__ebOriginal) node.__ebOriginal=node.nodeValue;
      const original=node.__ebOriginal;
      const translated=trText(original,lang);
      if(translated!==node.nodeValue) node.nodeValue=translated;
    });
    root.querySelectorAll && root.querySelectorAll('input[placeholder],textarea[placeholder],[title]').forEach(el=>{
      if(isProtected(el)) return;
      if(el.hasAttribute('placeholder')){ if(!el.dataset.ebPlaceholder) el.dataset.ebPlaceholder=el.getAttribute('placeholder'); const v=trText(el.dataset.ebPlaceholder,lang); el.setAttribute('placeholder',v); }
      if(el.hasAttribute('title')){ if(!el.dataset.ebTitle) el.dataset.ebTitle=el.getAttribute('title'); const v=trText(el.dataset.ebTitle,lang); el.setAttribute('title',v); }
    });
  }
  window.getSiteLanguage=function(){ return localStorage.getItem(LANG_KEY)==='es'?'es':'en'; };
  window.setSiteLanguage=function(lang){
    lang=lang==='es'?'es':'en'; localStorage.setItem(LANG_KEY,lang); document.documentElement.lang=lang;
    const select=document.getElementById('languageSelect'); if(select) select.value=lang;
    walk(document.body,lang);
    window.dispatchEvent(new CustomEvent('epicbloxs-language-change',{detail:{language:lang}}));
  };
  window.applySiteLanguage=function(){ setSiteLanguage(getSiteLanguage()); };
  document.addEventListener('DOMContentLoaded',()=>{
    const select=document.getElementById('languageSelect'); if(select) select.value=getSiteLanguage();
    setSiteLanguage(getSiteLanguage());
    const observer=new MutationObserver(muts=>{ if(window.__ebTranslating)return; window.__ebTranslating=true; try{ muts.forEach(m=>m.addedNodes.forEach(n=>{ if(n.nodeType===1) walk(n,getSiteLanguage()); })); } finally{window.__ebTranslating=false;} });
    observer.observe(document.body,{childList:true,subtree:true});
  });
})();
</script>

(function(){ const m=location.pathname.match(/^\/perfil\/(\d+)$/); if(m){ setTimeout(()=>openUserProfile(m[1]),0); } })();'''
if marker not in s: raise SystemExit('end marker not found')
s=s.replace(marker,js,1)
p.write_text(s,encoding='utf-8')
