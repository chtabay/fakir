import { GameSession, FAMILIES, UPGRADES, AUTO_RATES } from './game-state.js';
import { NetworkView } from './network-view.js';
import { evaluateExpression } from './calculator.js';

const $=id=>document.getElementById(id);
const SAVE_KEY='fakir-v3-progress';
const PREVIOUS_SAVE_KEY='fakir-v2-progress';
const integer=new Intl.NumberFormat('fr-FR',{maximumFractionDigits:0});
const decimal=new Intl.NumberFormat('fr-FR',{minimumFractionDigits:3,maximumFractionDigits:3});
const percent=value=>`${Math.round(value*100)} %`;
const fmt=value=>Number.isFinite(value)?decimal.format(value):'—';
let game=new GameSession();
let view='machine',lastSample=null,preview={a:2,b:3},lastMeasured=0,lastUi=0,autoCredit=0,dirty=false,toastTimeout,audioContext;
let introAnimating=false,inputControlsKey='',displayed={a:2,b:3,type:'add'};
let storageFailed=false,reduceBySystem=matchMedia('(prefers-reduced-motion: reduce)').matches;
try {
  const saved=localStorage.getItem(SAVE_KEY);
  if(saved)game.restore(saved);
  $('previous-game').hidden=!localStorage.getItem(PREVIOUS_SAVE_KEY);
}
catch(error) { storageFailed=true; console.warn('Fakir : progression non chargée.',error.message); }
const networkView=new NetworkView($('network'));
networkView.onSample=(sample,phase)=>{
  displayed={a:sample.a,b:sample.b,type:sample.type};
  updateReadout(phase==='before'?sample.before:sample.after,sample.target);
  $('current-calculation').textContent=sample.a+' '+FAMILIES[sample.type].symbol+' '+sample.b;
  renderInputControls();
  if(phase==='after'){const wasIntro=introAnimating&&game.data.phase===0;introAnimating=false;$('train').disabled=false;if(wasIntro){measure();render();}}
};

function toast(message) { $('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>$('toast').classList.remove('visible'),4200); }
function save() {
  try { localStorage.setItem(SAVE_KEY,JSON.stringify(game.exportState()));dirty=false;storageFailed=false;$('save-status').textContent='Enregistré';$('save-status').classList.remove('failed'); }
  catch { storageFailed=true;$('save-status').textContent='Enregistrement indisponible';$('save-status').classList.add('failed'); }
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
  const example=game.data.selected||preview,type=game.data.family;
  const prediction=game.lab.predict(type,example.a,example.b);
  displayed={...example,type};
  networkView.setState({network:game.lab.getNetwork(type),prediction,example:{...example,type,target:game.target(type,example.a,example.b)},reducedMotion:game.data.preferences.reducedMotion||reduceBySystem});
  updateReadout(prediction.value,game.target(type,example.a,example.b));
  $('current-calculation').textContent=example.a+' '+FAMILIES[type].symbol+' '+example.b;
  renderInputControls();
}
function renderInputControls() {
  const maximum=game.curriculum==='small'?4:9;
  const key=game.data.family+':'+maximum;
  if(key!==inputControlsKey){
    for(const [id,min] of [['input-a',0],['input-b',game.data.family==='div'?1:0]]){
      $(id).replaceChildren(...Array.from({length:maximum-min+1},(_,index)=>{const option=document.createElement('option');option.value=String(index+min);option.textContent=String(index+min);return option;}));
    }
    inputControlsKey=key;
  }
  const example=game.data.selected||displayed;
  $('input-a').value=String(example.a);$('input-b').value=String(example.b);
  $('input-symbol').textContent=FAMILIES[game.data.family].symbol;
}
function chooseInputs() {
  const a=Number($('input-a').value),b=Number($('input-b').value);
  if(!game.selectExample(a,b))return;
  game.data.autoEnabled=false;autoCredit=0;introAnimating=false;lastSample=null;
  preview={a,b};dirty=true;showNetwork();render();
  if(view==='repertoire')renderHeatmap();
}

function updateReadout(prediction,target) { $('prediction').textContent=fmt(prediction);$('target').textContent=Number.isInteger(target)?integer.format(target):fmt(target);$('error').textContent=fmt(Math.abs(prediction-target)); }
function changeView(next) {
  if(next==='repertoire'&&game.data.phase<1)return;
  if(next==='calculator'&&game.data.phase<3)return;
  view=next;
  document.querySelectorAll('.view-tab').forEach(button=>{const selected=button.dataset.view===next;button.classList.toggle('selected',selected);button.setAttribute('aria-selected',String(selected));});
  for(const name of ['machine','repertoire','calculator'])$(name+'-view').hidden=name!==next;
  if(next==='repertoire')renderHeatmap();
  if(next==='machine')showNetwork();
  if(next==='calculator')renderCalculatorKeys();
}
function train(count,manual) {
  if(manual&&introAnimating)return;
  const sample=game.train(count,{manual});if(!sample)return;
  lastSample=sample;preview={a:sample.a,b:sample.b};dirty=true;
  introAnimating=manual&&game.clickPower===1;
  if(view==='machine')networkView.animate(sample,game.lab.getNetwork(game.data.family));
  else {displayed={a:sample.a,b:sample.b,type:sample.type};updateReadout(sample.after,sample.target);introAnimating=false;}
  if(manual)sound();
  if(manual||performance.now()-lastMeasured>600)measure();
  if(manual)render();
}

function measure() {
  game.refreshMetrics();lastMeasured=performance.now();
  if(introAnimating&&game.data.phase===0)return;
  const milestone=game.checkMilestone();
  if(milestone){
    introAnimating=false;lastSample=null;preview={a:2,b:3};inputControlsKey='';
    if(milestone.phase===1)game.selectExample(2,3);
    const discoveries=['','Autres additions disponibles.','100 additions disponibles.','Calculatrice et soustraction disponibles.','Multiplication disponible.','Division disponible.','Parcours terminé.'];
    toast(discoveries[milestone.phase]);sound(true);
    showNetwork();renderOperations();renderUpgrades();
    if(view==='calculator')renderCalculatorKeys();save();
  }
  if(view==='repertoire')renderHeatmap();
}

function renderOperations() {
  $('operation-switcher').replaceChildren(...game.unlocked.map(type=>{
    const family=FAMILIES[type],button=document.createElement('button');
    button.type='button';button.className='operation-button'+(type===game.data.family?' active':'');
    button.textContent=family.symbol;button.setAttribute('aria-label',family.label);button.setAttribute('aria-pressed',String(type===game.data.family));
    button.addEventListener('click',()=>{game.selectFamily(type);lastSample=null;preview={a:2,b:3};introAnimating=false;inputControlsKey='';renderOperations();showNetwork();render();if(view==='repertoire')renderHeatmap();dirty=true;});
    return button;
  }));
}

function renderUpgrades() {
  $('upgrades').replaceChildren(...UPGRADES.map(upgrade=>{
    const item=document.createElement('article');item.className='upgrade';item.dataset.upgrade=upgrade.id;
    const button=document.createElement('button');button.type='button';button.dataset.buy=upgrade.id;
    button.append(document.createElement('span'),document.createElement('span'));
    const detail=document.createElement('small');detail.dataset.level=upgrade.id;
    button.addEventListener('click',()=>{if(game.purchase(upgrade.id)){
      if(upgrade.id==='auto'){game.data.selected=null;autoCredit=0;}
      dirty=true;sound(true);updateUpgrades();render();save();
    }});
    item.append(button,detail);return item;
  }));
  updateUpgrades();
}

function updateUpgrades() {
  let visible=0;
  for(const upgrade of UPGRADES){
    const item=document.querySelector('[data-upgrade="'+upgrade.id+'"]'),button=item.querySelector('button');
    const level=game.data.upgrades[upgrade.id],price=upgrade.prices[level];
    const locked=game.total<upgrade.minExamples||game.data.phase<upgrade.minPhase,maxed=price===undefined;
    item.hidden=locked;if(locked)continue;visible++;
    const label=upgrade.id==='batch'?'Grouper les billes':upgrade.id==='auto'?(level?'Accélérer':'Automatiser'):'Cibler les erreurs';
    button.disabled=maxed||game.data.balance<price;
    button.firstElementChild.textContent=maxed?(upgrade.id==='focus'?'Erreurs ciblées':'Maximum atteint'):label;
    button.lastElementChild.textContent=maxed?'':integer.format(price)+' crédits';
    const detail=upgrade.id==='batch'?game.clickPower+(maxed?'':' → '+(game.clickPower*2))+' exemples / clic':upgrade.id==='auto'?AUTO_RATES[level]+(maxed?'':' → '+AUTO_RATES[level+1])+' exemples / s':'1 exemple sur 5';
    item.querySelector('small').textContent=detail;
    button.setAttribute('aria-label',button.firstElementChild.textContent+(maxed?'':', '+price+' crédits, '+detail));
  }
  $('workshop-panel').hidden=visible===0;
}

function render() {
  const metrics=game.metrics,phase=game.data.phase;
  $('balance').textContent=integer.format(game.data.balance);$('total-count').textContent=integer.format(game.total);
  $('revision-count-wrap').hidden=game.revisions===0;$('revision-count').textContent=integer.format(game.revisions);
  $('current-calculation').textContent=displayed.a+' '+FAMILIES[displayed.type].symbol+' '+displayed.b;
  $('current-calculation').hidden=phase>=1;
  $('input-controls').hidden=phase<1;
  $('view-navigation').hidden=phase<1;
  $('repertoire-tab').hidden=phase<1;$('repertoire-tab').disabled=phase<1;
  $('repertoire-tab').firstChild.textContent=metrics.total+' calculs';
  $('calculator-tab').hidden=phase<3;$('calculator-tab').disabled=phase<3;
  $('operation-switcher').hidden=game.unlocked.length<2;
  $('metrics-panel').hidden=phase<1;
  $('train-label').textContent=game.clickPower===1?'Lancer une bille':'Lancer '+integer.format(game.clickPower)+' billes';
  $('train').disabled=introAnimating;
  $('auto-toggle').hidden=game.data.upgrades.auto===0;
  $('auto-toggle').disabled=false;
  $('auto-toggle').setAttribute('aria-pressed',String(game.data.upgrades.auto>0&&game.data.autoEnabled));
  $('auto-label').textContent=game.data.autoEnabled?AUTO_RATES[game.data.upgrades.auto]+' / s · pause':'Reprendre';
  $('auto-toggle').querySelector('.auto-icon').textContent=game.data.autoEnabled?'Ⅱ':'▷';
  $('sample-control-wrap').hidden=!game.data.selected||phase<2;
  $('sample-clear').textContent='Tous les cas';
  $('metric-mae').textContent=fmt(metrics.mae);$('metric-accuracy').textContent=percent(metrics.accuracy);$('metric-rate').textContent=game.autoRate+' / s';
  $('metric-accuracy-label').textContent='Écart ≤ '+String(metrics.tolerance).replace('.',',');
  $('metrics-scope').textContent=metrics.total+' calculs';
  renderInputControls();updateUpgrades();lastUi=performance.now();
}

function renderHeatmap() {
  const type=game.data.family,max=game.curriculum==='small'?4:9,selected=game.data.selected;
  const fragment=document.createDocumentFragment();
  $('heatmap').style.gridTemplateColumns='repeat('+(max+2)+', minmax(0, 1fr))';
  for(let row=-1;row<=max;row++)for(let col=-1;col<=max;col++) {
    if(row===-1||col===-1){const span=document.createElement('span');span.className='heatmap-heading';span.textContent=row===-1&&col===-1?FAMILIES[type].symbol:row===-1?col:row;fragment.append(span);continue;}
    const button=document.createElement('button');button.className='heatmap-cell';button.type='button';
    if(type==='div'&&col===0){button.disabled=true;button.textContent='—';button.setAttribute('aria-label','Division par zéro non définie');fragment.append(button);continue;}
    const raw=game.lab.predict(type,row,col).value,target=game.target(type,row,col),error=Math.abs(raw-target),quality=Math.exp(-error/(type==='div'?.3:1.4));
    button.style.setProperty('--cell-color',`rgb(${Math.round(248-quality*69)},${Math.round(247-quality*35)},${Math.round(242-quality*47)})`);
    button.textContent=type==='div'?raw.toFixed(1).replace('.',','):String(Math.round(raw));button.title=`${row} ${FAMILIES[type].symbol} ${col} ≈ ${fmt(raw)} · erreur ${fmt(error)}`;
    button.setAttribute('aria-label',button.title);button.classList.toggle('unseen',row>max||col>max);button.classList.toggle('selected',!!selected&&selected.a===row&&selected.b===col);
    button.disabled=row>max||col>max;
    button.addEventListener('click',()=>{if(game.selectExample(row,col)){game.data.autoEnabled=false;autoCredit=0;preview={a:row,b:col};lastSample=null;renderHeatmap();dirty=true;}});
    fragment.append(button);
  }
  $('heatmap').replaceChildren(fragment);$('grid-scope').textContent=FAMILIES[type].label;
  if(selected){const value=game.lab.predict(type,selected.a,selected.b).value,target=game.target(type,selected.a,selected.b);$('sample-readout').textContent=`${selected.a} ${FAMILIES[type].symbol} ${selected.b} ≈ ${fmt(value)} · écart ${fmt(Math.abs(value-target))}`;}
  else $('sample-readout').textContent='';
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
    const label=document.createElement('span');label.textContent='Estimation';
    const estimate=document.createElement('strong');estimate.textContent=`≈ ${new Intl.NumberFormat('fr-FR',{minimumFractionDigits:4,maximumFractionDigits:4}).format(result.estimate)}`;
    const rounded=document.createElement('small');rounded.textContent=`Résultat composé : ${new Intl.NumberFormat('fr-FR',{maximumFractionDigits:4}).format(result.result)}`;
    output.append(label,estimate,rounded);
    $('calculation-steps').replaceChildren(...result.trace.map(step=>{const p=document.createElement('p');p.textContent=step;return p;}));$('calculation-trace').hidden=false;
  } catch(error){output.classList.add('error');output.textContent=error.message||'Ce calcul ne peut pas être effectué.';}
}
function applyPreferences() { const reduced=game.data.preferences.reducedMotion||reduceBySystem;document.body.classList.toggle('reduce-motion',reduced);$('sound-enabled').checked=game.data.preferences.sound;$('motion-reduced').checked=game.data.preferences.reducedMotion;showNetwork(); }
function reset() { introAnimating=false;inputControlsKey='';game=new GameSession();lastSample=null;preview={a:2,b:3};autoCredit=0;view='machine';document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());renderOperations();renderUpgrades();applyPreferences();changeView('machine');render();save();toast('Nouvelle partie.'); }

$('train').addEventListener('click',()=>train(game.clickPower,true));
$('input-a').addEventListener('change',chooseInputs);
$('input-b').addEventListener('change',chooseInputs);
document.addEventListener('keydown',event=>{if(event.code!=='Space'||event.altKey||event.ctrlKey||event.metaKey)return;const target=event.target;if(target.closest('input,textarea,select,button,summary,a,[contenteditable]')||document.querySelector('dialog[open]'))return;event.preventDefault();train(game.clickPower,true);});
document.querySelectorAll('.view-tab').forEach(button=>button.addEventListener('click',()=>changeView(button.dataset.view)));
$('auto-toggle').addEventListener('click',()=>{game.data.autoEnabled=!game.data.autoEnabled;if(game.data.autoEnabled)game.data.selected=null;autoCredit=0;dirty=true;render();});
$('sample-clear').addEventListener('click',()=>{game.data.selected=null;dirty=true;render();});
$('watch-sample').addEventListener('click',()=>changeView('machine'));
$('calculator-form').addEventListener('submit',calculate);
$('settings-open').addEventListener('click',()=>{$('settings-dialog').showModal();});
document.querySelectorAll('.dialog-close').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const bounds=dialog.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();}}));
$('sound-enabled').addEventListener('change',event=>{game.data.preferences.sound=event.target.checked;dirty=true;sound();save();});
$('motion-reduced').addEventListener('change',event=>{networkView.finishImmediately();game.data.preferences.reducedMotion=event.target.checked;dirty=true;applyPreferences();save();});
$('export-save').addEventListener('click',()=>{save();const blob=new Blob([JSON.stringify(game.exportState(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`fakir-progression-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Partie exportée.');});
$('import-save').addEventListener('click',()=>$('save-file').click());
$('save-file').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{if(file.size>2_000_000)throw new Error('Ce fichier est trop volumineux.');const candidate=new GameSession();candidate.restore(await file.text());game=candidate;introAnimating=false;inputControlsKey='';lastSample=null;preview=game.selectedExample;autoCredit=0;renderOperations();renderUpgrades();applyPreferences();if(game.data.phase<3&&view==='calculator')changeView('machine');if(game.data.phase<1&&view==='repertoire')changeView('machine');if(view==='calculator')renderCalculatorKeys();if(view==='repertoire')renderHeatmap();render();save();$('settings-dialog').close();toast('Partie reprise.');}catch(error){toast(error.message||'Ce fichier ne peut pas être importé.');}finally{event.target.value='';}});
$('reset-game').addEventListener('click',()=>{$('settings-dialog').close();$('reset-dialog').showModal();});
$('confirm-reset').addEventListener('click',reset);
window.addEventListener('pagehide',()=>{if(dirty)save();});
document.addEventListener('visibilitychange',()=>{autoCredit=0;if(document.hidden&&dirty)save();});

renderOperations();renderUpgrades();renderCalculatorKeys();applyPreferences();render();
if(storageFailed){$('save-status').textContent='Sauvegarde non chargée · export disponible';$('save-status').classList.add('failed');toast('Sauvegarde illisible.');}
let lastTick=performance.now();
setInterval(()=>{const now=performance.now(),delta=Math.min(.5,(now-lastTick)/1000);lastTick=now;if(document.hidden)return;if(game.autoRate>0){autoCredit+=delta*game.autoRate;const count=Math.floor(autoCredit);if(count){autoCredit-=count;train(count,false);}}if(now-lastUi>400)render();},200);
setInterval(()=>{if(dirty)save();},5000);
