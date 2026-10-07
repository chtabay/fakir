import { GameSession, CHAPTERS, FAMILIES, UPGRADES, AUTO_RATES } from './game-state.js';
import { NetworkView } from './network-view.js';
import { evaluateExpression } from './calculator.js';

const $=id=>document.getElementById(id);
const SAVE_KEY='fakir-v2-progress';
const integer=new Intl.NumberFormat('fr-FR',{maximumFractionDigits:0});
const decimal=new Intl.NumberFormat('fr-FR',{minimumFractionDigits:3,maximumFractionDigits:3});
const percent=value=>`${Math.round(value*100)} %`;
const fmt=value=>Number.isFinite(value)?decimal.format(value):'—';
let game=new GameSession();
let view='machine',lastSample=null,preview={a:2,b:3},lastMeasured=0,lastUi=0,autoCredit=0,dirty=false,toastTimeout,audioContext;
let storageFailed=false,reduceBySystem=matchMedia('(prefers-reduced-motion: reduce)').matches;
try { const saved=localStorage.getItem(SAVE_KEY);if(saved)game.restore(saved); }
catch(error) { storageFailed=true; console.warn('Fakir : progression non chargée.',error.message); }
const networkView=new NetworkView($('network'));
networkView.onSample=(sample,phase)=>{
  updateReadout(phase==='before'?sample.before:sample.after,sample.target);
  $('last-correction').textContent=phase==='before'
    ?`${sample.a} ${FAMILIES[sample.type].symbol} ${sample.b} · la machine propose ${fmt(sample.before)}`
    :`${sample.a} ${FAMILIES[sample.type].symbol} ${sample.b} : ${fmt(sample.before)} → ${fmt(sample.after)}${sample.errorAfter<=sample.errorBefore?'':' · un ajustement à poursuivre'}`;
};

function toast(message) { $('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>$('toast').classList.remove('visible'),4200); }
function save() {
  try { localStorage.setItem(SAVE_KEY,JSON.stringify(game.exportState()));dirty=false;storageFailed=false;$('save-status').textContent='Progression sauvegardée ici';$('save-status').classList.remove('failed'); }
  catch { storageFailed=true;$('save-status').textContent='Sauvegarde indisponible · exporte ta progression';$('save-status').classList.add('failed'); }
}
function sound(success=false) {
  if(!game.data.preferences.sound)return;
  try {
    audioContext ||= new (window.AudioContext||window.webkitAudioContext)();
    if(audioContext.state==='suspended')audioContext.resume();
    const oscillator=audioContext.createOscillator(),gain=audioContext.createGain();
    oscillator.type='sine';oscillator.frequency.setValueAtTime(success?640:420+Math.min(220,game.trained/50),audioContext.currentTime);
    gain.gain.setValueAtTime(.0001,audioContext.currentTime);gain.gain.exponentialRampToValueAtTime(.035,audioContext.currentTime+.012);gain.gain.exponentialRampToValueAtTime(.0001,audioContext.currentTime+.18);
    oscillator.connect(gain);gain.connect(audioContext.destination);oscillator.start();oscillator.stop(audioContext.currentTime+.2);
  } catch { /* Le son est facultatif. */ }
}
function showNetwork() {
  const example=game.data.selected || preview;
  const type=game.data.family;
  const prediction=game.lab.predict(type,example.a,example.b);
  networkView.setState({network:game.lab.getNetwork(type),prediction,example:{...example,type,target:game.target(type,example.a,example.b)},reducedMotion:game.data.preferences.reducedMotion||reduceBySystem});
  updateReadout(prediction.value,game.target(type,example.a,example.b));
  $('network-size').textContent='2 entrées · 24 neurones · 1 sortie';
}
function updateReadout(prediction,target) { $('prediction').textContent=fmt(prediction);$('target').textContent=Number.isInteger(target)?integer.format(target):fmt(target);$('error').textContent=fmt(Math.abs(prediction-target)); }
function changeView(next) {
  if(next==='repertoire'&&game.data.phase<1){toast('Le répertoire s’ouvre après le premier déclic.');return;}
  if(next==='calculator'&&game.data.phase<3){toast('La calculatrice s’ouvre quand la table d’addition est prête.');return;}
  view=next;
  document.querySelectorAll('.view-tab').forEach(button=>{const selected=button.dataset.view===next;button.classList.toggle('selected',selected);button.setAttribute('aria-selected',String(selected));});
  for(const name of ['machine','repertoire','calculator'])$(name+'-view').hidden=name!==next;
  if(next==='repertoire')renderHeatmap();
  if(next==='machine')showNetwork();
  if(next==='calculator')renderCalculatorKeys();
}
function train(count,manual) {
  const sample=game.train(count,{manual});if(!sample)return;
  lastSample=sample;preview={a:sample.a,b:sample.b};dirty=true;
  if(view==='machine')networkView.animate(sample,game.lab.getNetwork(game.data.family));
  if(view!=='machine')updateReadout(sample.after,sample.target);
  if(manual)sound();
  if(manual || performance.now()-lastMeasured>600)measure();
  if(manual)render();
}
function measure() {
  game.refreshMetrics();lastMeasured=performance.now();
  const milestone=game.checkMilestone();
  if(milestone) {
    lastSample=null;preview={a:2,b:3};
    toast(`${milestone.phase===6?'Parcours accompli !':milestone.chapter.name+' !'} + ${integer.format(milestone.reward)} éclats`);
    sound(true);showNetwork();renderChapters();renderOperations();renderUpgrades();if(view==='calculator')renderCalculatorKeys();save();
    $('last-correction').textContent=milestone.phase===1?'Le réseau découvre de nouveaux exemples. Son erreur peut remonter.':'Une nouvelle étape, de nouveaux essais.';
  }
  if(view==='repertoire')renderHeatmap();
}
function renderChapters() {
  $('chapters').replaceChildren(...CHAPTERS.slice(0,6).map((chapter,i)=>{
    const li=document.createElement('li');li.className='chapter'+(i===game.data.phase?' current':i<game.data.phase?' completed':'');
    if(i===game.data.phase)li.setAttribute('aria-current','step');
    const marker=document.createElement('span');marker.className='chapter-marker';marker.textContent=i<game.data.phase?'✓':String(i+1).padStart(2,'0');
    const title=document.createElement('strong');title.textContent=chapter.name;
    const subtitle=document.createElement('small');subtitle.textContent=chapter.subtitle;
    li.append(marker,title,subtitle);return li;
  }));
}
function renderOperations() {
  $('operation-switcher').replaceChildren(...Object.entries(FAMILIES).map(([type,family])=>{
    const button=document.createElement('button');button.type='button';button.className='operation-button'+(type===game.data.family?' active':'');button.textContent=family.symbol;button.title=family.label;button.setAttribute('aria-label',family.label);button.setAttribute('aria-pressed',String(type===game.data.family));button.disabled=!game.unlocked.includes(type);
    button.addEventListener('click',()=>{game.selectFamily(type);lastSample=null;preview={a:2,b:3};renderOperations();showNetwork();render();if(view==='repertoire')renderHeatmap();dirty=true;});return button;
  }));
}
function levelDescription(upgrade) {
  const level=game.data.upgrades[upgrade.id];
  return upgrade.id==='batch'?`${game.clickPower} exemple${game.clickPower>1?'s':''} / clic`:upgrade.id==='auto'?`${AUTO_RATES[level]} exemple${AUTO_RATES[level]>1?'s':''} / s`:level?'Répétition active':'Cibler les erreurs';
}
function renderUpgrades() {
  $('upgrades').replaceChildren(...UPGRADES.map(upgrade=>{
    const item=document.createElement('article');item.className='upgrade';item.dataset.upgrade=upgrade.id;
    const head=document.createElement('div');head.className='upgrade-header';
    const icon=document.createElement('span');icon.className='upgrade-icon';icon.textContent=upgrade.icon;icon.setAttribute('aria-hidden','true');
    const name=document.createElement('div'),strong=document.createElement('strong'),small=document.createElement('small');strong.textContent=upgrade.name;small.dataset.level=upgrade.id;name.append(strong,small);head.append(icon,name);
    const description=document.createElement('p');description.textContent=upgrade.description;
    const button=document.createElement('button');button.type='button';button.dataset.buy=upgrade.id;button.append(document.createElement('span'),document.createElement('span'));
    button.addEventListener('click',()=>{if(game.purchase(upgrade.id)){dirty=true;toast(`${upgrade.name} · ${levelDescription(upgrade)}`);sound(true);updateUpgrades();render();save();}});
    item.append(head,description,button);return item;
  }));updateUpgrades();
}
function updateUpgrades() {
  for(const upgrade of UPGRADES) {
    const item=document.querySelector(`[data-upgrade="${upgrade.id}"]`),button=item.querySelector('button'),level=game.data.upgrades[upgrade.id],price=upgrade.prices[level];
    const locked=game.total<upgrade.minExamples||game.data.phase<upgrade.minPhase,maxed=price===undefined;
    item.classList.toggle('locked',locked);item.querySelector('small').textContent=levelDescription(upgrade);
    button.disabled=locked||maxed||game.data.balance<price;
    button.firstElementChild.textContent=maxed?'Au maximum':locked?(game.data.phase<upgrade.minPhase?'Après le répertoire':`Dès ${upgrade.minExamples} exemples`):level?'Améliorer':'Installer';
    button.lastElementChild.textContent=maxed?'✓':`✧ ${integer.format(price)}`;
    button.setAttribute('aria-label',maxed?`${upgrade.name} au maximum`:`${level?'Améliorer':'Installer'} ${upgrade.name}, ${price} éclats`);
  }
}
function renderChart() {
  const points=game.data.histories[game.scopeKey]||[];
  if(!points.length)return;
  const max=Math.max(.05,...points.map(p=>p.mae)),last=points.at(-1).trained,first=points[0].trained;
  const values=points.map((p,i)=>[points.length===1?2:2+(p.trained-first)/Math.max(1,last-first)*256,65-p.mae/max*58]);
  const line=values.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  $('chart-line').setAttribute('d',line);$('chart-area').setAttribute('d',line+` L${values.at(-1)[0]},70 L${values[0][0]},70 Z`);
  $('sparkline').setAttribute('aria-label',`Erreur moyenne sur ${game.metrics.total} calculs : ${fmt(points[0].mae)} au début de la courbe, ${fmt(points.at(-1).mae)} maintenant.`);
}
function render() {
  const chapter=game.chapter,metrics=game.metrics;
  $('balance').textContent=integer.format(game.data.balance);$('total-count').textContent=integer.format(game.total);
  $('chapter-kicker').textContent=game.data.phase<6?`CHAPITRE ${String(game.data.phase+1).padStart(2,'0')} · ${chapter.name.toLocaleUpperCase('fr')}`:'LES QUATRE OPÉRATIONS RÉUNIES';
  $('chapter-title').textContent=chapter.title;$('chapter-description').textContent=chapter.description;
  $('repertoire-tab').disabled=game.data.phase<1;$('repertoire-tab').querySelector('.tab-lock').hidden=game.data.phase>=1;
  $('calculator-tab').disabled=game.data.phase<3;$('calculator-tab').querySelector('.tab-lock').hidden=game.data.phase>=3;
  $('train-label').textContent=game.clickPower===1?'Lâcher une bille':'Lâcher une volée';
  $('train-detail').textContent=`${game.clickPower} exemple${game.clickPower>1?'s':''} · touche Espace`;
  $('auto-toggle').disabled=game.data.upgrades.auto===0;$('auto-toggle').setAttribute('aria-pressed',String(game.data.upgrades.auto>0&&game.data.autoEnabled));
  $('auto-label').textContent=!game.data.upgrades.auto?'Automate en attente':game.data.autoEnabled?`${AUTO_RATES[game.data.upgrades.auto]} exemple${AUTO_RATES[game.data.upgrades.auto]>1?'s':''} / s`:'Automate en pause';
  $('auto-toggle').querySelector('.auto-icon').textContent=game.data.autoEnabled&&game.data.upgrades.auto?'Ⅱ':'▷';
  $('machine-status').textContent=game.data.selected?'Exemple choisi':game.data.upgrades.auto&&game.data.autoEnabled?'Apprentissage en cours':'Prête pour un exemple';
  $('sample-control-wrap').hidden=!game.data.selected;
  $('metric-mae').textContent=fmt(metrics.mae);$('metric-accuracy').textContent=percent(metrics.accuracy);$('metric-rate').textContent=`${game.autoRate} / s`;
  $('metric-accuracy-label').textContent=`À moins de ${String(metrics.tolerance).replace('.',',')} d’erreur`;
  $('metrics-scope').textContent=`${metrics.total} calcul${metrics.total>1?'s':''}`;
  $('measure-explanation').textContent=metrics.total===1?'Mesuré en demandant 2 + 3 au modèle, sans le corriger.':`Mesuré sur les ${metrics.total} calculs du répertoire étudié, sans correction. La courbe peut remonter quand le programme s’élargit.`;
  const progress=game.milestoneProgress();
  $('milestone-title').textContent=chapter.goal;$('milestone-description').textContent=chapter.detail;$('milestone-symbol').textContent=game.data.phase===6?'✓':String(game.data.phase+1).padStart(2,'0');
  $('milestone-progress').textContent=game.data.phase===6?'PARCOURS ACCOMPLI':`${integer.format(Math.min(progress.trained,chapter.min))} / ${integer.format(chapter.min)}${game.data.phase?` · ${percent(progress.accuracy)}`:''}`;
  $('milestone-bar').style.width=`${progress.ratio*100}%`;
  updateUpgrades();renderChart();lastUi=performance.now();
}
function renderHeatmap() {
  const type=game.data.family,max=game.curriculum==='small'?4:9,selected=game.data.selected;
  const fragment=document.createDocumentFragment();
  for(let row=-1;row<10;row++)for(let col=-1;col<10;col++) {
    if(row===-1||col===-1){const span=document.createElement('span');span.className='heatmap-heading';span.textContent=row===-1&&col===-1?FAMILIES[type].symbol:row===-1?col:row;fragment.append(span);continue;}
    const button=document.createElement('button');button.className='heatmap-cell';button.type='button';
    if(type==='div'&&col===0){button.disabled=true;button.textContent='—';button.setAttribute('aria-label','Division par zéro non définie');fragment.append(button);continue;}
    const raw=game.lab.predict(type,row,col).value,target=game.target(type,row,col),error=Math.abs(raw-target),quality=Math.exp(-error/(type==='div'?.3:1.4));
    button.style.setProperty('--cell-color',`rgb(${Math.round(21+quality*52)},${Math.round(35+quality*119)},${Math.round(30+quality*77)})`);
    button.textContent=type==='div'?raw.toFixed(1).replace('.',','):String(Math.round(raw));button.title=`${row} ${FAMILIES[type].symbol} ${col} ≈ ${fmt(raw)} · erreur ${fmt(error)}`;
    button.setAttribute('aria-label',button.title);button.classList.toggle('unseen',row>max||col>max);button.classList.toggle('selected',!!selected&&selected.a===row&&selected.b===col);
    button.disabled=row>max||col>max;
    button.addEventListener('click',()=>{if(game.selectExample(row,col)){game.data.autoEnabled=false;autoCredit=0;preview={a:row,b:col};lastSample=null;renderHeatmap();dirty=true;}});
    fragment.append(button);
  }
  $('heatmap').replaceChildren(fragment);$('grid-scope').textContent=FAMILIES[type].label;
  if(selected){const value=game.lab.predict(type,selected.a,selected.b).value,target=game.target(type,selected.a,selected.b);$('sample-readout').textContent=`${selected.a} ${FAMILIES[type].symbol} ${selected.b} : ${fmt(value)} proposé, ${fmt(target)} attendu. Erreur : ${fmt(Math.abs(value-target))}.`;}
  else $('sample-readout').textContent='Les couleurs viennent des réponses du modèle. Choisis un calcul pour le travailler manuellement.';
}
function renderCalculatorKeys() {
  const keys=['7','8','9','÷','4','5','6','×','1','2','3','−','0',',','C','+'];
  const types={'÷':'div','×':'mul','−':'sub','+':'add'};
  $('calculator-keys').replaceChildren(...keys.map(key=>{
    const button=document.createElement('button');button.type='button';button.textContent=key;
    if(types[key]){button.className='operation-key';button.disabled=!game.unlocked.includes(types[key]);button.setAttribute('aria-label',FAMILIES[types[key]].label);}
    if(key==='C')button.setAttribute('aria-label','Effacer le calcul');
    button.addEventListener('click',()=>{const input=$('calculation');if(key==='C')input.value='';else input.value+=key;input.focus();});return button;
  }));
}
function calculate(event) {
  event.preventDefault();const output=$('calculation-output');output.classList.remove('error');output.replaceChildren();$('calculation-trace').hidden=true;
  try {
    const result=evaluateExpression($('calculation').value,game.lab,game.unlocked);
    const label=document.createElement('span');label.textContent='Estimation issue des opérations apprises';
    const estimate=document.createElement('strong');estimate.textContent=`≈ ${new Intl.NumberFormat('fr-FR',{minimumFractionDigits:4,maximumFractionDigits:4}).format(result.estimate)}`;
    const rounded=document.createElement('small');rounded.textContent=`Résultat composé : ${new Intl.NumberFormat('fr-FR',{maximumFractionDigits:4}).format(result.result)}`;
    const context=document.createElement('small');context.textContent=`Briques utilisées : ${result.uses.map(type=>FAMILIES[type]?.label.toLowerCase()||type).join(', ')}. Une erreur dans une brique peut se propager.`;
    output.append(label,estimate,rounded,context);
    $('calculation-steps').replaceChildren(...result.trace.map(step=>{const p=document.createElement('p');p.textContent=step;return p;}));$('calculation-trace').hidden=false;
  } catch(error){output.classList.add('error');output.textContent=error.message||'Ce calcul ne peut pas être effectué.';}
}
function applyPreferences() { const reduced=game.data.preferences.reducedMotion||reduceBySystem;document.body.classList.toggle('reduce-motion',reduced);$('sound-enabled').checked=game.data.preferences.sound;$('motion-reduced').checked=game.data.preferences.reducedMotion;showNetwork(); }
function reset() { game=new GameSession();lastSample=null;preview={a:2,b:3};autoCredit=0;view='machine';document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());renderChapters();renderOperations();renderUpgrades();applyPreferences();changeView('machine');render();save();toast('Une nouvelle bille. Une nouvelle expérience.'); }

$('train').addEventListener('click',()=>train(game.clickPower,true));
document.addEventListener('keydown',event=>{if(event.code!=='Space'||event.altKey||event.ctrlKey||event.metaKey)return;const target=event.target;if(target.closest('input,textarea,select,button,summary,a,[contenteditable]')||document.querySelector('dialog[open]'))return;event.preventDefault();train(game.clickPower,true);});
document.querySelectorAll('.view-tab').forEach(button=>button.addEventListener('click',()=>changeView(button.dataset.view)));
$('auto-toggle').addEventListener('click',()=>{game.data.autoEnabled=!game.data.autoEnabled;if(game.data.autoEnabled)game.data.selected=null;autoCredit=0;dirty=true;render();});
$('sample-clear').addEventListener('click',()=>{game.data.selected=null;dirty=true;render();toast('Le programme reprend ses exemples variés.');});
$('watch-sample').addEventListener('click',()=>changeView('machine'));
$('calculator-form').addEventListener('submit',calculate);
$('settings-open').addEventListener('click',()=>{$('settings-dialog').showModal();});
$('help-open').addEventListener('click',()=>{$('help-dialog').showModal();});
document.querySelectorAll('.dialog-close').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const bounds=dialog.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();}}));
$('sound-enabled').addEventListener('change',event=>{game.data.preferences.sound=event.target.checked;dirty=true;sound();save();});
$('motion-reduced').addEventListener('change',event=>{game.data.preferences.reducedMotion=event.target.checked;dirty=true;applyPreferences();save();});
$('export-save').addEventListener('click',()=>{save();const blob=new Blob([JSON.stringify(game.exportState(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`fakir-progression-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Progression exportée avec les poids appris.');});
$('import-save').addEventListener('click',()=>$('save-file').click());
$('save-file').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{if(file.size>2_000_000)throw new Error('Ce fichier est trop volumineux.');const candidate=new GameSession();candidate.restore(await file.text());game=candidate;lastSample=null;preview=game.selectedExample;autoCredit=0;renderChapters();renderOperations();renderUpgrades();applyPreferences();if(game.data.phase<3&&view==='calculator')changeView('machine');if(game.data.phase<1&&view==='repertoire')changeView('machine');if(view==='calculator')renderCalculatorKeys();if(view==='repertoire')renderHeatmap();render();save();$('settings-dialog').close();toast('Ta machine a retrouvé ses apprentissages.');}catch(error){toast(error.message||'Ce fichier ne peut pas être importé.');}finally{event.target.value='';}});
$('reset-game').addEventListener('click',()=>{$('settings-dialog').close();$('reset-dialog').showModal();});
$('confirm-reset').addEventListener('click',reset);
window.addEventListener('pagehide',()=>{if(dirty)save();});
document.addEventListener('visibilitychange',()=>{autoCredit=0;if(document.hidden&&dirty)save();});

renderChapters();renderOperations();renderUpgrades();renderCalculatorKeys();applyPreferences();render();
if(storageFailed){$('save-status').textContent='Sauvegarde non chargée · export disponible';$('save-status').classList.add('failed');toast('La progression précédente n’a pas pu être chargée. Tu peux importer une sauvegarde depuis les réglages.');}
let lastTick=performance.now();
setInterval(()=>{const now=performance.now(),delta=Math.min(.5,(now-lastTick)/1000);lastTick=now;if(document.hidden)return;if(game.autoRate>0){autoCredit+=delta*game.autoRate;const count=Math.floor(autoCredit);if(count){autoCredit-=count;train(count,false);}}if(now-lastUi>400)render();},200);
setInterval(()=>{if(dirty)save();},5000);
