import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Loader2, Plus, RotateCcw, SlidersHorizontal, ArrowUp } from 'lucide-react'
import { CREATE_PRESETS, type CreatePreset } from '../../../lib/render/create-presets'
import { STUDIO_MODELS, studioFields, studioSchema, studioOptions, studioPreviewCredits, supportsProviderField } from '../../../lib/render/studio-contract'
import { classicCredits, modelHint, presetModel, presetModels, requiredRoleInputs, roleInputs, rolePrompts, roleHasChoice } from '../../../lib/render/preset-models'
import { studioShownValue } from '../../../lib/render/create-studio'
import { promptIdeas } from '../../../lib/render/prompt-ideas'
import { groupForPicker, tierMarks } from '../../../lib/render/model-tier'
import { humanRuntime, type ModelRuntime } from '../../../lib/render/runtime-format'
import { selectedVideoSeconds, videoDurations } from '../../../lib/render/video-duration'
import { studioQuote, modelRuntimes, StudioQuoteChangedError } from '../../../api/cloud/studio'
import { uploadInput, submitCloudJob, pollJob, getJob, cancelJob, QuoteChangedError, type CloudJob, type CloudJobParams } from '../../../api/cloud/jobs'
import { galleryItemFromJob } from '../../../lib/render/cloud-jobs'
import { useCreateStore } from '../../../stores/createStore'
import { useCreateExp } from './CreateContext'
import { SchemaControl, baseFieldClass } from './SchemaControl'
import { Select } from '../ui/Select'
import { galleryLabelShort } from '../../../lib/render/gallery-label'
import { errorText } from '../../../types/json-guards'
import { CloudJobError } from '../../../api/cloud/client'
import { useDebouncedValue } from '../../../hooks/useDebouncedValue'
import { PROMPT_DEBOUNCE_MS } from './useStudioPrice'

const label = (s: string) => s.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())

/** Der gemeinsame Feldstil des Create-Tabs, dunkel gestellt fuer die
 *  schwarze Mulde dieses Fensters. Ein natives `<select>` bekommt damit
 *  auch den Pfeil des Hauses statt des Systempfeils (index.css,
 *  `.lu-field-dark`); die Felder der Expert-Schublade bleiben unberuehrt. */
const fieldClass = `${baseFieldClass} lu-field-dark`

export function PresetWorkshop({preset,onClose,onGenerate}:{preset:CreatePreset;onClose:()=>void;onGenerate:()=>void}) {
  const [index,setIndex]=useState(0),[prompt,setPrompt]=useState(''),[options,setOptions]=useState<Record<string,unknown>>({})
  const [paths,setPaths]=useState<Record<string,string|string[]>>({}),[completed,setCompleted]=useState<Record<number,CloudJob>>({})
  const [measurement,setMeasurement]=useState<{key:string;seconds:number}|null>(null)
  const [advanced,setAdvanced]=useState(false),[quoting,setQuoting]=useState(false),[quotedKey,setQuotedKey]=useState('')
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[quote,setQuote]=useState<number|null>(null),[active,setActive]=useState<string|null>(null)
  // Review B5 (Runde 4, 20.09.2026): true exactly while the MOST RECENT
  // quote attempt for the current priceKey came back 429 (rate limited, not
  // a version gap). While true, the last CONFIRMED quote/quotedKey (from
  // before the rate limit hit) stays usable for Generate even though it no
  // longer matches `priceKey` exactly, see the disabled-condition comments
  // below. Reset to false by any attempt that resolves with a real answer
  // (success, 409, or a genuine error) and by every place that already
  // clears `quote` for an unrelated reason (model switch, step change).
  const [rateLimited,setRateLimited]=useState(false)
  const lock=useRef(false),requestId=useRef<string|null>(null)
  // Asks for a fresh quote although the inputs did not change: after a result
  // is dropped (redo) the price key is the same, and Generate stayed disabled
  // (bug hunt 01.10.2026, K3).
  const [quoteRound,setQuoteRound]=useState(0)
  const previewsRef=useRef<Record<string,{url:string;type:'image'|'video'}>>({})
  const carried=useRef<number|null>(null)
  // Gemessene Laufzeiten, einmal pro geoeffnetem Fenster geholt. Fehlt das
  // Modell darin, hat es noch zu wenige Laeufe und wir sagen nichts dazu.
  const [runtimes,setRuntimes]=useState<Record<string,ModelRuntime>>({})
  const [elapsed,setElapsed]=useState(0)
  useEffect(()=>{
    let cancelled=false
    void modelRuntimes().then(r=>{if(!cancelled)setRuntimes(r)})
    return ()=>{cancelled=true}
  },[])
  useEffect(()=>{
    if(!active){setElapsed(0);return}
    const started=Date.now()
    const timer=setInterval(()=>setElapsed(Math.floor((Date.now()-started)/1000)),1000)
    return ()=>clearInterval(timer)
  },[active])
  const [picked,setPicked]=useState<Record<number,string>>({})
  // Was der Kunde hochgeladen hat, gehoert in die Vorschau. Das Preset-Bild
  // ist eine Illustration und nicht sein Material; stand es dort weiter,
  // sah er beim Start nicht, womit er gerade arbeitet.
  const [previews,setPreviews]=useState<Record<string,{url:string;type:'image'|'video'}>>({})
  function setPreview(key:string,blob:Blob|null) {
    setPreviews(prev=>{
      const next={...prev}
      if(prev[key])URL.revokeObjectURL(prev[key].url)
      delete next[key]
      const type=blob?.type.startsWith('image/')?'image':blob?.type.startsWith('video/')?'video':null
      if(blob&&type){const url=URL.createObjectURL(blob);next[key]={url,type}}
      return next
    })
  }
  function dropPreviews(keep?:(key:string)=>boolean) {
    setPreviews(prev=>{
      const next:typeof prev={}
      for(const [key,value] of Object.entries(prev)){
        if(keep?.(key))next[key]=value
        else URL.revokeObjectURL(value.url)
      }
      return next
    })
  }
  previewsRef.current=previews
  // Ein Objekt-URL, den niemand freigibt, haelt die Datei im Speicher fest.
  useEffect(()=>()=>{for(const v of Object.values(previewsRef.current))URL.revokeObjectURL(v.url)},[])
  const {refreshQuota}=useCreateExp();const gallery=useCreateStore(s=>s.gallery)
  const raw=preset.steps[index]
  // The preset names a model; the customer may run the step on any other model
  // of the same role. Everything below follows the CHOICE and never the
  // preset's suggestion, so kind, schema, inputs and price stay one thing.
  // An adult preset keeps its step on the open endpoints. A filtered one
  // would refuse the run and still cost the credits.
  const alternatives=presetModels(raw.role,preset.adult).filter(m=>!raw.models||raw.models.includes(m.id))
  const choice=presetModel(raw.role,picked[index]??raw.model)??{id:raw.model,label:raw.model,kind:raw.kind,op:raw.op,adult:preset.adult}
  const step={...raw,model:choice.id,kind:choice.kind,op:choice.op}
  const model=STUDIO_MODELS[step.model], fields=model?studioFields(step.model):{}
  const inputs={...roleInputs(raw.role,step.model),...(!model&&raw.role==='animate'&&supportsProviderField(step.model,'audio','animate')?{audio:'audio_path'}:{})}
  const required=requiredRoleInputs(raw.role,step.model)
  function choose(id:string) {
    if(id===step.model)return
    setPicked(p=>({...p,[index]:id}));setOptions({});setQuote(null);setQuotedKey('');setError('');setRateLimited(false)
    // An upload the next model does not read would still price and submit as a
    // stray param. Only what it consumes survives the switch.
    const keep=new Set([...Object.values(roleInputs(raw.role,id)),'source_url'])
    setPaths(p=>Object.fromEntries(Object.entries(p).filter(([k])=>keep.has(k))));dropPreviews(k=>keep.has(k))
  }


  const inputList=Object.entries(inputs)
  // Pflichteingaben stehen oben. Alles Optionale, etwa ein Endbild, liegt
  // unter den erweiterten Einstellungen: es gehoert nicht zum Fluss und
  // machte das Panel nur voll.
  const requiredList=inputList.filter(([,key])=>required.includes(key))
  const optionalList=inputList.filter(([,key])=>!required.includes(key))
  async function upload(key:string, files:FileList|null) {
    if (!files?.length || lock.current)return
    setBusy(true);setError('');lock.current=true
    try { const role:'source'|'mask'|'audio'|'video'=key==='image_paths'?'source':key==='mask_path'?'mask':key.includes('audio')?'audio':key==='video_path'?'video':'source';const list:string[]=[];for (const f of Array.from(files))list.push(await uploadInput(f,role));setPaths(p=>({...p,[key]:key==='image_paths'?list:list[0]}));setPreview(key,files[0]) }
    catch(e){setError(errorText(e))}finally{setBusy(false);lock.current=false}
  }
  async function adopt(job:CloudJob,key:string) {
    setBusy(true);setError('');lock.current=true
    try { const fresh=await getJob(job.id);if(!fresh.result_url)throw new Error('Result is not available');const res=await fetch(fresh.result_url);if(!res.ok)throw new Error('Could not load the previous result');const blob=await res.blob();const path=await uploadInput(blob,key.includes('audio')?'audio':key==='video_path'?'video':'source');setPaths(p=>({...p,[key]:key==='image_paths'?[path]:path}));setPreview(key,blob) }
    catch(e){setError(errorText(e))}finally{setBusy(false);lock.current=false}
  }
  function params():CloudJobParams {
    if(model)return {op:'studio',...paths,studio_options:options} as CloudJobParams
    const p:CloudJobParams={op:step.op,...paths} as CloudJobParams
    if(raw.role==='animate'){
      // The route prices a clip from frames/fps and ignores `duration`. Sending
      // the wrong one books the default length and the quote is rejected.
      // Review A kleiner Punkt 4 (Runde 2 report): this reads the QUIET
      // snap (selectedVideoSeconds), not the loud-throwing bookedVideoSeconds
      // the Create tab's classic booking uses, on purpose: the Workshop
      // already requires a server-confirmed `quote` before Generate unlocks
      // (quote===null blocks it, see the priceKey effect above), so an
      // invalid length here would have failed that quote call already, with
      // its own visible error, before this function is ever reached.
      const seconds=selectedVideoSeconds(step.model,Number(options.duration??5)*16,16)
      p.frames=seconds*16;p.fps=16
      if(supportsProviderField(step.model,'shot_type','animate')&&(options.shot_type==='single'||options.shot_type==='multi'))p.shot_type=options.shot_type
    }
    if(raw.role==='image'){p.width=1024;p.height=1024}
    if((raw.role==='image'||raw.role==='animate')&&supportsProviderField(step.model,'negative_prompt',step.op)&&options.negative_prompt)p.negative_prompt=String(options.negative_prompt)
    if(raw.role==='speech'){
      if(step.model==='qwen3-tts-design')p.voice_description=String(options.voice_description??'')
      else if(step.model!=='qwen3-tts-clone')p.voice=String(options.voice??'Serena')
    }
    if(raw.role==='extend')p.source_url=String(paths.source_url??'')
    return p
  }
  const classicCost=(p:CloudJobParams)=>classicCredits(step.kind,step.model,step.op,p)
  const measurementKey=JSON.stringify([paths,options.order??'meanwhile'])
  const estimate=model?studioPreviewCredits(step.model,options,measurement?.key===measurementKey?measurement.seconds:undefined,Array.isArray(paths.image_paths)?paths.image_paths.length:1,Array.from(prompt).length):classicCost(params())
  // Review B5 (Runde 4, 20.09.2026): only the PROMPT gets the longer
  // debounce, same as useStudioPrice.ts's fix (model/options/paths/index
  // change rarely, a real edit, not per keystroke). While the customer is
  // still typing, `debouncedPrompt` (and therefore `priceKey`) does not
  // move at all, so the effect below never re-runs mid-sentence and the
  // last confirmed `quote` simply stays where it is, usable, the whole
  // time (Opus B: "den alten bestaetigten Preis stehen lassen, solange nur
  // der Prompt weitergewachsen ist"). Measured before this fix: 48
  // studioQuote calls for a 48-char prompt at an ordinary 600ms/char typing
  // rhythm, the same disease review-studio-B.md's B4 found in the Composer.
  const debouncedPrompt=useDebouncedValue(prompt,PROMPT_DEBOUNCE_MS)
  const priceKey=JSON.stringify([step.model,debouncedPrompt,options,paths,index])
  const schemaRequired=model?studioSchema(step.model).required??[]:[]
  const promptRequired=model?schemaRequired.includes(model.promptField??'prompt'):rolePrompts(raw.role)
  // Review B5 (Runde 4, 20.09.2026): checked against the LIVE prompt, not
  // `debouncedPrompt`. Clearing a required prompt makes the last confirmed
  // quote wrong for what would actually be submitted, and that is a
  // correctness gap, not the keystroke-chatter the debounce above exists to
  // fix, so it must not wait 1800ms to take effect (preset-workshop.test.tsx,
  // "invalidates the prior quote when the prompt is cleared").
  const nothingToPrice=required.some(key=>!paths[key])||(!model&&raw.role==='extend'&&!paths.source_url)||(promptRequired&&!prompt.trim())
  useEffect(()=>{
    const controller=new AbortController()
    // Genuinely nothing to price yet (no upload, no required prompt): the
    // ONLY case that still clears the last quote outright, there is no
    // number to fall back to either.
    if(required.some(key=>!paths[key])||(!model&&raw.role==='extend'&&!paths.source_url)||(promptRequired&&!debouncedPrompt.trim())){
      setQuote(null);setQuotedKey('');setQuoting(false);setRateLimited(false)
      return
    }
    setQuoting(true)
    const timer=setTimeout(async()=>{
      try {
        let cost:number
        if(model){
          studioOptions(step.model,debouncedPrompt,options)
          const data=await studioQuote(step.model,debouncedPrompt,{op:'studio',studio_options:options,...paths})
          if(!Number.isSafeInteger(data.credits)||data.credits<1)throw new Error('Invalid price response')
          cost=data.credits
          if(!controller.signal.aborted&&Number.isFinite(data.seconds))setMeasurement({key:measurementKey,seconds:data.seconds as number})
        }else{
          const classic=classicCost(params())
          // Kein Katalogpreis (aelterer Notvorrat, noch keine erste
          // Katalogaktualisierung): lieber schweigen als eine erfundene Zahl
          // zeigen. Der Startknopf bleibt gesperrt, weil `quote` null bleibt.
          if(classic===null)throw new Error('No price is available for this model yet.')
          cost=classic
        }
        if(!controller.signal.aborted){setQuote(cost);setQuotedKey(priceKey);requestId.current=crypto.randomUUID();setError('');setRateLimited(false)}
      }catch(e){
        if(controller.signal.aborted)return
        // 409 quote_changed: den neuen, vom Anbieter bestaetigten Preis
        // zeigen und als bestaetigt uebernehmen, NICHT still weiterbuchen.
        // Der Kunde sieht die neue Zahl und muss noch einmal auf Start
        // druecken (Portplan Abschnitt 4/7, Risiko 1).
        if(e instanceof StudioQuoteChangedError){
          setQuote(e.credits);setQuotedKey(priceKey);requestId.current=crypto.randomUUID()
          if(Number.isFinite(e.seconds))setMeasurement({key:measurementKey,seconds:e.seconds as number})
          setError('The price changed. Review the new price before starting.');setRateLimited(false)
        } else if(e instanceof CloudJobError&&e.status===429){
          // Review B5: a 429 here is the rate limit, not a version gap and
          // not a sign the last confirmed price is wrong. Leave `quote`/
          // `quotedKey` exactly as they were (the last good number, if any)
          // and mark `rateLimited` so Generate still accepts them even
          // though `quotedKey` no longer matches this newer `priceKey`; no
          // blocking alert, same silent-fallback shape as useStudioPrice.ts.
          setRateLimited(true);setError('')
        } else {
          // A real error (invalid options, no catalog price, ...): the
          // shown number, if any, is genuinely no longer trustworthy.
          setQuote(null);setQuotedKey('');setRateLimited(false);setError(errorText(e))
        }
      }
      finally{if(!controller.signal.aborted)setQuoting(false)}
    },650)
    return ()=>{clearTimeout(timer);controller.abort()}
    // The key contains every input affecting the quote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[priceKey,quoteRound])
  // Review B5: usable when there is genuinely something to price, and it is
  // fresh for the CURRENT key, or the only thing between here and a fresh
  // confirmation is a rate limit (the last confirmed number stands in, see
  // the effect's 429 branch above).
  const priceUsable=!nothingToPrice&&quote!==null&&(quotedKey===priceKey||rateLimited)
  async function generate() {
    if(lock.current||!priceUsable||useCreateStore.getState().isGenerating)return
    lock.current=true;setBusy(true);setError('')
    const store=useCreateStore.getState()
    store.setIntent(raw.role==='extend'?'extend':raw.role==='animate'?'animate':raw.role==='motion'?'motion':raw.role==='talking'||raw.role==='duo'?'lipsync':raw.role==='edit'?'edit':step.kind==='audio'?'music':step.kind==='video'?'video':'image')
    store.setIsGenerating(true);store.setProgress(0,`Generating ${preset.title}`);store.setProgressPhase('queued');onGenerate()
    try {
      // Der letzte Schritt traegt den Namen des Presets allein: er IST das
      // Ergebnis. Die Schritte davor sagen dazu, welcher sie waren, sonst
      // liegen drei Zwischenstaende gleichen Namens in der Galerie.
      const runLabel=index===preset.steps.length-1?preset.title:`${preset.title} · ${step.title}`
      const submitted=await submitCloudJob({kind:step.kind,model:step.model,prompt,params:{...params(),label:runLabel,max_credits:quote,client_request_id:requestId.current??undefined}})
      setActive(submitted.id)
      // The id served its purpose once a job stands for it. A second Generate
      // is a new request: with the old id the server handed back the failed or
      // cancelled job instead of starting one (K3).
      requestId.current=crypto.randomUUID()
      const job=await pollJob(submitted.id,{timeoutMs:125*60_000})
      if(job.status!=='succeeded')throw new Error(job.error??`Generation ${job.status}. Completed earlier steps remain in your gallery.`)
      // Prompt und Titel stehen hier im Browser; der Auftrag vom Server
      // bringt sie erst beim naechsten Laden mit.
      store.addToGallery({...galleryItemFromJob(job),prompt,label:runLabel});setCompleted(c=>({...c,[index]:job}));setQuote(null);setRateLimited(false)
    }catch(e){
      if(e instanceof QuoteChangedError){
        // Der Server hat beim Buchen neu gerechnet und eine hoehere Zahl
        // gefunden als die bestaetigte. Zeigen statt buchen: derselbe
        // Grundsatz wie beim 409 der Preisabfrage oben, nur an der anderen
        // Stelle des Ablaufs (Portplan Abschnitt 4 Punkt 3).
        setQuote(e.credits);setQuotedKey(priceKey);requestId.current=crypto.randomUUID();setRateLimited(false)
        setError(`The price changed to ${e.credits.toLocaleString('en-US')} credits. Review it and start again.`)
      } else {
        setError(errorText(e));store.setError(errorText(e))
      }
    }finally{setActive(null);store.setIsGenerating(false);setBusy(false);lock.current=false;void refreshQuota()}
  }
  function next(){setIndex(index+1);setPrompt('');setOptions({});setPaths({});dropPreviews();setError('');setQuote(null);setQuotedKey('');setRateLimited(false)}
  /** Drop this step's result and stand where it was made, prompt and uploads
   *  still there. A second run of the same step is one word away, not a
   *  reopened preset that silently resumes on a finished picture. */
  function redo(){setCompleted(c=>{const n={...c};delete n[index];return n});setError('');setQuote(null);setQuotedKey('');setRateLimited(false);setQuoteRound(r=>r+1)}
  /** Back to an empty first step. Nothing carried over, model choice included.
   *  Everything already generated stays in the gallery. */
  function startOver(){carried.current=null;setIndex(0);setPrompt('');setOptions({});setPaths({});dropPreviews();setCompleted({});setPicked({});setMeasurement(null);setError('');setQuote(null);setQuotedKey('');setAdvanced(false);setRateLimited(false);setQuoteRound(r=>r+1)}
  const touched=index>0||Object.keys(completed).length>0||!!prompt||Object.keys(paths).length>0
  const ideas=promptIdeas(raw.role,preset.category)
  const runtime=runtimes[step.model]
  const clock=`${Math.floor(elapsed/60)}:${String(elapsed%60).padStart(2,'0')}`
  // Sein eigenes Material schlaegt die Illustration. Reihenfolge nach dem,
  // was den Schritt traegt: erst das Standbild, dann der Clip.
  const stage=['source_path','image_paths','last_image_path','video_path'].map(k=>previews[k]).find(Boolean)
  const prev=completed[index-1]
  const result=completed[index]
  /** Welche Eingabe dieses Schrittes ein Ergebnis dieser Art fuellt. */
  function slotFor(kind:string):string|undefined {
    return inputList.find(([,key])=>(kind==='image'&&(key==='source_path'||key==='image_paths'))||(kind==='audio'&&key==='audio_path')||(kind==='video'&&key==='video_path'))?.[1]
  }
  // Der naechste Schritt bekommt das Ergebnis des vorigen von selbst. Vorher
  // stand dort ein leeres Feld und ein Knopf: der Kunde haette die Datei
  // herunterladen und wieder hochladen muessen, um weiterzukommen.
  useEffect(()=>{
    if(carried.current===index||!prev?.result_url||busy)return
    const key=slotFor(prev.kind)
    if(!key||paths[key])return
    carried.current=index
    void adopt(prev,key)
    // Nur beim Betreten des Schrittes, und genau einmal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[index,prev?.id])
  const primaryFields=Object.entries(fields).filter(([key])=>['duration','resolution','target_resolution','target_megapixels','upscale_factor','music_length_ms','voice','voice_id','avatar','language','emotion','preset','horizontal_angle','vertical_angle','distance','order'].includes(key))
  const otherFields=Object.entries(fields).filter(([key])=>!primaryFields.some(([p])=>p===key))
  return <section aria-label={`${preset.title} workspace`} className="flex min-h-0 flex-1 flex-col overflow-hidden">
    {/* Die Kopfzeile des Fensters. Sie war eine zentrierte Brotkrume UNTER
        dem Haus-Kopf, also stand der Titel zweimal da; jetzt ist sie der
        Kopf selbst, auf voller Breite, mit der Haarlinie des Hauses darunter
        und `pr-12` Platz fuer das X, das ueber ihr schwebt. */}
    <div className="flex w-full shrink-0 items-center gap-3 border-b border-white/[0.08] px-5 py-3 pr-12 t-micro">
      <span className="font-medium text-gray-100">{preset.title}</span><span className="text-gray-400">/</span>
      {preset.steps.map((s,i)=><span key={i} className={`flex items-center gap-1.5 ${i===index?'text-gray-100':'text-gray-400'}`}>{completed[i]?<Check size={10} className="text-emerald-400"/>:<span className="font-mono t-micro">{i+1}</span>}{s.title}{i<preset.steps.length-1&&<ChevronRight size={10} className="ml-1 text-gray-400"/>}</span>)}
      {touched&&<button onClick={startOver} disabled={busy} className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 t-micro text-gray-400 hover:bg-white/5 hover:text-gray-100 disabled:opacity-40"><RotateCcw size={10}/>Start over</button>}
    </div>
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
      <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto scrollbar-thin p-4">
        {result ? <div className="flex h-full w-full flex-col items-center justify-center gap-2">{result.kind==='image'?<img src={result.result_url!} alt="Generated result" className="min-h-0 max-h-full max-w-full rounded-lg object-contain"/>:result.kind==='audio'?<audio src={result.result_url!} controls/>:<video src={result.result_url!} controls className="min-h-0 max-h-full max-w-full rounded-lg"/>}<span className="t-micro text-gray-400">Saved to your gallery</span></div> : <div className="text-center">{busy?<Loader2 size={20} className="mx-auto mb-3 animate-spin text-gray-400"/>:stage?(stage.type==='image'?<img src={stage.url} alt="Your input" className="mx-auto mb-4 max-h-[38vh] w-auto max-w-full rounded-lg object-contain"/>:<video src={stage.url} controls className="mx-auto mb-4 max-h-[38vh] w-auto max-w-full rounded-lg"/>):<img src={`/create-presets/${CREATE_PRESETS.some(p=>p.id===preset.id)?preset.id:step.kind==='image'?'product-scene':'restyle-video'}.webp?v=2`} alt="Preset inspiration" className="mx-auto mb-4 max-h-[38vh] w-full max-w-sm rounded-lg object-contain"/>}<h3 className="text-sm font-medium text-gray-400">{active?'Creating your result…':step.title}</h3>{active&&<p className="mt-1 t-control tabular-nums text-lu-accent">{clock}{runtime?` of ${humanRuntime(runtime.seconds)}`:''}</p>}<p className="mx-auto mt-2 max-w-xs text-balance t-control leading-5 text-gray-400">{preset.summary}</p></div>}
      </div>
      {(inputList.length>0||Object.keys(fields).length>0||raw.role==='animate'||raw.role==='extend'||raw.role==='speech'||preset.note)&&<aside className="w-full shrink-0 space-y-3 overflow-y-auto border-t border-white/[0.08] px-3 py-3 md:w-60 md:border-l md:border-t-0">
        <div className="flex items-center justify-between t-micro text-gray-400"><span>INPUTS & SETTINGS</span><SlidersHorizontal size={11}/></div>
        {requiredList.map(([field,key])=><div key={field}>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-white/10 bg-black/25 px-3 py-3 t-control text-gray-400 hover:border-lu-accent/50 hover:text-gray-200"><input disabled={busy} type="file" className="sr-only" multiple={key==='image_paths'} accept={key.includes('audio')?'audio/*':key==='video_path'?'video/*':'image/png,image/jpeg,image/webp'} onChange={e=>void upload(key,e.target.files)}/>{paths[key]?<Check size={13} className="text-emerald-400"/>:<Plus size={13}/>}<span>{paths[key]?'Replace':'Add'} {label(field).toLowerCase()}</span></label>
          {paths[key]&&<button disabled={busy} onClick={()=>{setPaths(p=>{const next={...p};delete next[key];return next});setPreview(key,null)}} className="mt-1 mr-3 t-micro text-gray-400">Remove input</button>}
          {key==='video_path'&&step.model==='preset-wan-2.2-spicy-extend'&&<select aria-label="Use a gallery clip" disabled={busy} value="" onChange={e=>{const item=gallery.find(g=>g.id===e.target.value);if(item)void adopt({id:item.id} as CloudJob,key)}} className={`${fieldClass} mt-2`}><option value="">Or use a gallery clip…</option>{gallery.filter(g=>g.type==='video'&&g.remoteUrl).map(g=><option key={g.id} value={g.id}>{galleryLabelShort(g,50)}</option>)}</select>}
        </div>)}
        {!model&&raw.role==='extend'&&<label className="block t-micro text-gray-400">Source clip<select disabled={busy} className={`${fieldClass} mt-1`} value={String(paths.source_url??'')} onChange={e=>setPaths({source_url:e.target.value})}><option value="">Choose from your gallery</option>{gallery.filter(g=>g.type==='video'&&g.remoteUrl).map(g=><option key={g.id} value={g.remoteUrl}>{g.model} · {new Date(g.createdAt).toLocaleString()}</option>)}</select></label>}
        <div className="grid grid-cols-2 gap-2">{primaryFields.map(([key,schema])=><SchemaControl key={key} className={fieldClass} name={key} schema={schema} value={studioShownValue(step.model,options,key)} disabled={busy} onChange={v=>setOptions(o=>{const next={...o};if(v===undefined)delete next[key];else next[key]=v;return next})}/>)}</div>
        {!model&&raw.role==='animate'&&<><SchemaControl className={fieldClass} name="duration" schema={{type:'integer',enum:[...videoDurations(step.model)],default:5}} value={options.duration} disabled={busy} onChange={v=>setOptions(o=>({...o,duration:Number(v)}))}/>{supportsProviderField(step.model,'shot_type','animate')&&<SchemaControl className={fieldClass} name="shot_type" schema={{type:'string',enum:['single','multi'],default:'single'}} value={options.shot_type} disabled={busy} onChange={v=>setOptions(o=>({...o,shot_type:v}))}/>}{supportsProviderField(step.model,'negative_prompt','animate')&&<label className="block t-micro text-gray-400">Negative prompt<textarea disabled={busy} value={String(options.negative_prompt??'')} onChange={e=>setOptions(o=>({...o,negative_prompt:e.target.value}))} className={`${fieldClass} mt-1`} placeholder="Details to avoid…"/></label>}</>}
        {!model&&raw.role==='speech'&&step.model==='qwen3-tts'&&<SchemaControl className={fieldClass} name="voice" schema={{type:'string',enum:['Serena','Vivian','Ryan','Aiden','Dylan','Eric','Sohee','Ono_Anna','Uncle_Fu'],default:'Serena'}} value={options.voice} disabled={busy} onChange={v=>setOptions({voice:v})}/>}
        {!model&&raw.role==='speech'&&step.model==='qwen3-tts-design'&&<label className="block t-micro text-gray-400">Voice description<textarea disabled={busy} value={String(options.voice_description??'')} onChange={e=>setOptions(o=>({...o,voice_description:e.target.value}))} className={`${fieldClass} mt-1`} placeholder="A calm low voice, slight rasp…"/></label>}
        {(otherFields.length>0||optionalList.length>0)&&<><button onClick={()=>setAdvanced(!advanced)} className="t-micro text-gray-400 hover:text-gray-100">{advanced?'−':'+'} Advanced settings</button>{advanced&&<div className="space-y-2">{optionalList.map(([field,key])=><div key={field}>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-white/10 bg-black/25 px-3 py-2.5 t-control text-gray-400 hover:border-lu-accent/50 hover:text-gray-200"><input disabled={busy} type="file" className="sr-only" multiple={key==='image_paths'} accept={key.includes('audio')?'audio/*':key==='video_path'?'video/*':'image/png,image/jpeg,image/webp'} onChange={e=>void upload(key,e.target.files)}/>{paths[key]?<Check size={13} className="text-emerald-400"/>:<Plus size={13}/>}<span>{paths[key]?'Replace':'Add'} {label(field).toLowerCase()}</span></label>
          {paths[key]&&<button disabled={busy} onClick={()=>{setPaths(p=>{const next={...p};delete next[key];return next});setPreview(key,null)}} className="mt-1 t-micro text-gray-400">Remove input</button>}
        </div>)}{otherFields.map(([key,schema])=><SchemaControl key={key} className={fieldClass} name={key} schema={schema} value={studioShownValue(step.model,options,key)} disabled={busy} onChange={v=>setOptions(o=>{const next={...o};if(v===undefined)delete next[key];else next[key]=v;return next})}/>)}</div>}</>}
        {preset.note&&<p className="t-micro leading-4 text-gray-400">{preset.note}</p>}
      </aside>}
    </div>
    <div className="mx-auto w-full max-w-[1000px] shrink-0 px-5 pb-4 pt-2">
      {error&&<p role="alert" className="mb-2 t-control text-red-300">{error}</p>}
      <div className="rounded-xl border border-white/[0.08] bg-black/25 p-3 transition-colors focus-within:border-white/20">
        {model&&studioSchema(step.model).properties?.prompt?.enum?<select className={fieldClass} aria-label="Visual style" disabled={busy} value={prompt} onChange={e=>setPrompt(e.target.value)} ><option value="">Choose a visual style…</option>{studioSchema(step.model).properties!.prompt.enum!.map(v=><option key={String(v)}>{String(v)}</option>)}</select>:<textarea aria-label="Preset prompt" disabled={busy||!!result} maxLength={4000} rows={2} value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder={raw.role==='speech'?'What should your character say?':raw.role==='soundtrack'?'Describe the sounds you want…':raw.role==='animate'||raw.role==='extend'?'Describe the movement…':raw.role==='edit'?'Describe the new setting…':'Describe your scene…'} className="w-full resize-none bg-transparent t-control text-gray-200 outline-none placeholder:text-gray-400"/>}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 md:flex-nowrap md:gap-3">
          <div className="flex min-w-0 items-center gap-2">{roleHasChoice(raw.role,preset.adult)&&!result
            ?<Select size="sm" ariaLabel="Model" className="max-w-[220px]" value={step.model} onChange={choose} options={groupForPicker(alternatives).map(({model:m,group})=>({value:m.id,label:m.label,group,tags:tierMarks(m)}))}/>
            :<span className="truncate rounded-md border border-white/[0.08] px-2 py-1 t-micro text-gray-300">{choice.label} <span className="ml-2 text-gray-400">Cloud</span></span>}
          {ideas.length>0&&!result&&<Select size="sm" ariaLabel="Prompt ideas" className="max-w-[160px]" placeholder="+ Prompt idea" value="" onChange={v=>{const idea=ideas.find(i=>i.label===v);if(idea)setPrompt(t=>t.trim()?`${t.trim()}, ${idea.text}`:idea.text)}} options={ideas.map(i=>({value:i.label,label:i.label}))}/>}
          </div>
          <div className="flex items-center gap-3">{active&&<button onClick={()=>void cancelJob(active).catch(e=>setError(e.message))} className="t-micro text-gray-400">Cancel</button>}{busy&&<Loader2 size={12} className="animate-spin text-gray-400"/>}{result ? <><button onClick={redo} disabled={busy} className="flex h-8 items-center gap-1.5 rounded-lg border border-white/[0.08] px-3 t-control text-gray-300 hover:bg-white/5 disabled:opacity-40"><RotateCcw size={11}/>Try again</button>{index<preset.steps.length-1?<button onClick={next} className="lu-primary flex h-8 items-center gap-2 rounded-lg px-3 t-control">Next step<ChevronRight size={12}/></button>:<button onClick={onClose} className="lu-primary h-8 rounded-lg px-3 t-control">Done</button>}</>:<><span aria-live="polite" className="t-control text-gray-400">{priceUsable&&quote!==null?`${quote.toLocaleString('en-US')} credits`:estimate!==null?`≈ ${estimate.toLocaleString('en-US')} credits`:'Upload media to calculate price'}{quoting&&<span className="ml-2 text-gray-400">Checking…</span>}{runtime&&!active&&<span className="ml-2 text-gray-400">· {humanRuntime(runtime.seconds)}</span>}</span><button disabled={busy||quoting||!priceUsable} onClick={()=>void generate()} className="lu-primary flex h-8 items-center gap-2 rounded-lg px-4 t-control">Generate<ArrowUp size={12}/></button></>}</div>
        </div>
      </div>
      {modelHint(step.model)&&!result&&<p className="mt-1.5 text-center t-micro leading-4 text-gray-400">{modelHint(step.model)}</p>}
      <p className="mt-1.5 text-center t-micro text-gray-400">Each step is billed separately · Results stay in your gallery</p>
    </div>
  </section>
}
