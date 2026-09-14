import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const DEMO_TENANT_ID='30000000-0000-4000-8000-000000000001';
const BASE='https://br-flat-leaf-ax492ag7-almuneerdemo.compute.c-4.us-east-2.aws.neon.tech';
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:5,ssl:{rejectUnauthorized:false}});
const cors={
  'access-control-allow-origin':'*',
  'access-control-allow-headers':'authorization,content-type,accept',
  'access-control-allow-methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'cache-control':'no-store'
};
function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,'content-type':'application/json; charset=utf-8'}})}
function err(message:string,status=400){return json({message},status)}
async function body(req:Request){try{return await req.json()}catch{return {}}}
function bearer(req:Request){const h=req.headers.get('authorization')||'';return h.toLowerCase().startsWith('bearer ')?h.slice(7):''}
function decodePayload(token:string){try{const p=token.split('.')[0];return JSON.parse(Buffer.from(p,'base64url').toString('utf8'))}catch{return null}}
async function validStudent(req:Request){
  const token=bearer(req); if(!token)return null;
  const check=await fetch(BASE+'/api/v1/student/exams',{headers:{authorization:`Bearer ${token}`,accept:'application/json'}});
  if(check.status!==200)return null;
  const p=decodePayload(token);
  if(!p||p.kind!=='student'||p.tenantId!==DEMO_TENANT_ID||!p.studentId)return null;
  return String(p.studentId);
}
function page(url:URL){return {page:Math.max(1,Number(url.searchParams.get('page')||1)),pageSize:Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||25)))}}
function cleanMetadata(v:any){if(!v||typeof v!=='object'||Array.isArray(v))return {};const out:any={};for(const [k,val] of Object.entries(v)){if(/^(correct|correctanswer|correct_answer|answer|answerkey|answer_key|solution|key)$/i.test(k))continue;out[k]=val}return out}
function publicQuestion(snapshot:any){const c={...snapshot,metadata:cleanMetadata(snapshot?.metadata)};delete c.explanation;if(Array.isArray(c.options))c.options=c.options.map((o:any)=>({key:o.key,content:String(o.content??''),sortOrder:o.sortOrder}));return c}
function normalize(v:any):string[]{return Array.isArray(v)?v.map(String).sort():v==null?[]:[String(v)]}
function grade(snapshot:any,answer:any):boolean|null{
  const type=String(snapshot.questionType||'');
  if(['mcq','true_false','multiple_select'].includes(type)){
    const correct=(snapshot.options||[]).filter((o:any)=>o.isCorrect).map((o:any)=>String(o.key)).sort();
    const submitted=normalize(answer); return correct.length===submitted.length&&correct.every((v:string,i:number)=>v===submitted[i]);
  }
  const expected=snapshot.metadata?.correctAnswer;
  if(expected===undefined||expected===null)return null;
  if(type==='numeric')return Number(answer)===Number(expected);
  if(['short_answer','fill_blank'].includes(type))return String(answer??'').trim().toLocaleLowerCase('ar')===String(expected).trim().toLocaleLowerCase('ar');
  return null;
}
async function startTraining(req:Request,studentId:string){
  const input:any=await body(req); const modes=['random','errors','weakness','taxonomy','unsolved','adaptive'];
  if(!modes.includes(input.mode))return err('وضع التدريب غير صالح',400);
  const count=Math.min(50,Math.max(1,Number(input.count||10)));
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    if(input.taxonomyId){const tax=await client.query(`SELECT 1 FROM taxonomy_nodes WHERE id=$1 AND tenant_id=$2 AND status='active'`,[input.taxonomyId,DEMO_TENANT_ID]);if(!tax.rowCount){await client.query('ROLLBACK');return err('التصنيف غير موجود',404)}}
    const sessionId=randomUUID();let where=`q.tenant_id=$1 AND q.status='active' AND q.deleted_at IS NULL`;const params:any[]=[DEMO_TENANT_ID,studentId,count];let joins='';let order=`md5(q.id::text || $4)`;params.push(sessionId);
    if(input.mode==='errors'){joins=`JOIN student_error_bank eb ON eb.question_id=q.id AND eb.tenant_id=q.tenant_id AND eb.student_id=$2`;where+=` AND eb.mistake_count>eb.correct_count`;order=`(eb.mistake_count-eb.correct_count) DESC,eb.last_mistake_at DESC NULLS LAST`}
    else if(input.mode==='weakness'){joins=`LEFT JOIN student_error_bank eb ON eb.question_id=q.id AND eb.tenant_id=q.tenant_id AND eb.student_id=$2`;where+=` AND COALESCE(eb.mistake_count,0)>0`;order=`(COALESCE(eb.mistake_count,0)-COALESCE(eb.correct_count,0)) DESC,md5(q.id::text || $4)`}
    else if(input.mode==='taxonomy'){params.push(input.taxonomyId);joins=`JOIN question_taxonomy qt ON qt.question_id=q.id`;where+=` AND qt.taxonomy_id=$5`}
    else if(input.mode==='unsolved'){where+=` AND NOT EXISTS (SELECT 1 FROM attempt_answers aa JOIN attempts a ON a.id=aa.attempt_id WHERE a.tenant_id=$1 AND a.student_id=$2 AND aa.question_id=q.id) AND NOT EXISTS (SELECT 1 FROM training_items ti JOIN training_sessions ts ON ts.id=ti.session_id WHERE ts.tenant_id=$1 AND ts.student_id=$2 AND ti.question_id=q.id AND ti.answered_at IS NOT NULL)`}
    else if(input.mode==='adaptive'){joins=`LEFT JOIN student_error_bank eb ON eb.question_id=q.id AND eb.tenant_id=q.tenant_id AND eb.student_id=$2`;order=`(COALESCE(eb.mistake_count,0)-COALESCE(eb.correct_count,0)) DESC,md5(q.id::text || $4)`}
    if(input.questionType){params.push(input.questionType);where+=` AND q.question_type=$${params.length}`}
    if(input.difficulty){params.push(input.difficulty);where+=` AND q.difficulty=$${params.length}`}
    const taxonomyIds=[...(Array.isArray(input.taxonomyIds)?input.taxonomyIds:[]),...(input.sourceId?[input.sourceId]:[])];
    if(taxonomyIds.length){params.push(taxonomyIds);where+=` AND EXISTS (SELECT 1 FROM question_taxonomy qtf WHERE qtf.question_id=q.id AND qtf.taxonomy_id=ANY($${params.length}::uuid[]))`}
    const qr=await client.query(`SELECT q.id,q.question_type,q.stem,q.explanation,q.difficulty,q.metadata,COALESCE(jsonb_agg(jsonb_build_object('key',qo.option_key,'content',qo.content,'isCorrect',qo.is_correct,'sortOrder',qo.sort_order) ORDER BY qo.sort_order) FILTER (WHERE qo.id IS NOT NULL),'[]'::jsonb) options FROM questions q ${joins} LEFT JOIN question_options qo ON qo.question_id=q.id WHERE ${where} GROUP BY q.id${['errors','weakness','adaptive'].includes(input.mode)?',eb.mistake_count,eb.correct_count,eb.last_mistake_at':''} ORDER BY ${order} LIMIT $3`,params);
    if(!qr.rowCount){await client.query('ROLLBACK');return err('لا توجد أسئلة تدريب مطابقة',404)}
    await client.query(`INSERT INTO training_sessions(id,tenant_id,student_id,mode,taxonomy_id,requested_count) VALUES($1,$2,$3,$4,$5,$6)`,[sessionId,DEMO_TENANT_ID,studentId,input.mode,input.taxonomyId??null,count]);
    for(let i=0;i<qr.rows.length;i++){const q=qr.rows[i];const snap={questionId:q.id,questionType:q.question_type,stem:String(q.stem??''),explanation:q.explanation??null,difficulty:q.difficulty,metadata:q.metadata,options:q.options};await client.query(`INSERT INTO training_items(session_id,question_id,sort_order,snapshot) VALUES($1,$2,$3,$4::jsonb)`,[sessionId,q.id,i,JSON.stringify(snap)])}
    await client.query('COMMIT');
    return json({sessionId,mode:input.mode,total:qr.rows.length,questions:qr.rows.map((q:any)=>publicQuestion({questionId:q.id,questionType:q.question_type,stem:String(q.stem??''),difficulty:q.difficulty,metadata:q.metadata,options:q.options}))});
  }catch(e:any){await client.query('ROLLBACK');console.error(e?.message||e);return err('تعذر بدء التدريب',500)}finally{client.release()}
}
async function resumeTraining(studentId:string,sessionId:string){
  const sr=await pool.query(`SELECT id,mode,status,started_at FROM training_sessions WHERE id=$1 AND tenant_id=$2 AND student_id=$3`,[sessionId,DEMO_TENANT_ID,studentId]);if(!sr.rowCount)return err('جلسة التدريب غير موجودة',404);
  const items=await pool.query(`SELECT question_id,sort_order,snapshot,answer,is_correct,answered_at FROM training_items WHERE session_id=$1 ORDER BY sort_order`,[sessionId]);
  return json({...sr.rows[0],questions:items.rows.map((r:any)=>({...publicQuestion(r.snapshot),questionId:r.question_id,sortOrder:r.sort_order,answer:r.answer,isCorrect:r.is_correct,answeredAt:r.answered_at}))});
}
async function answerTraining(req:Request,studentId:string,sessionId:string){
  const input:any=await body(req);if(!input.questionId)return err('questionId مطلوب',400);const client=await pool.connect();
  try{await client.query('BEGIN');const r=await client.query(`SELECT ti.snapshot FROM training_items ti JOIN training_sessions ts ON ts.id=ti.session_id WHERE ts.id=$1 AND ts.tenant_id=$2 AND ts.student_id=$3 AND ts.status='active' AND ti.question_id=$4 FOR UPDATE`,[sessionId,DEMO_TENANT_ID,studentId,input.questionId]);if(!r.rowCount){await client.query('ROLLBACK');return err('عنصر التدريب غير موجود',404)}
    const snapshot=r.rows[0].snapshot;const ok=grade(snapshot,input.answer);await client.query(`UPDATE training_items SET answer=$2::jsonb,is_correct=$3,answered_at=CURRENT_TIMESTAMP WHERE session_id=$1 AND question_id=$4`,[sessionId,JSON.stringify(input.answer),ok,input.questionId]);
    if(ok===false)await client.query(`INSERT INTO student_error_bank(tenant_id,student_id,question_id,mistake_count,last_mistake_at) VALUES($1,$2,$3,1,CURRENT_TIMESTAMP) ON CONFLICT(student_id,question_id) DO UPDATE SET mistake_count=student_error_bank.mistake_count+1,last_mistake_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`,[DEMO_TENANT_ID,studentId,input.questionId]);
    if(ok===true)await client.query(`INSERT INTO student_error_bank(tenant_id,student_id,question_id,correct_count,last_correct_at) VALUES($1,$2,$3,1,CURRENT_TIMESTAMP) ON CONFLICT(student_id,question_id) DO UPDATE SET correct_count=student_error_bank.correct_count+1,last_correct_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`,[DEMO_TENANT_ID,studentId,input.questionId]);
    const progress=await client.query(`SELECT COUNT(*) FILTER (WHERE answered_at IS NOT NULL)::int answered,COUNT(*)::int total FROM training_items WHERE session_id=$1`,[sessionId]);const done=progress.rows[0].answered===progress.rows[0].total;if(done)await client.query(`UPDATE training_sessions SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=$1`,[sessionId]);await client.query('COMMIT');
    return json({isCorrect:ok,explanation:snapshot.explanation??null,correctAnswer:ok===null?null:(snapshot.options||[]).filter((o:any)=>o.isCorrect).map((o:any)=>o.key),progress:progress.rows[0],completed:done});
  }catch(e:any){await client.query('ROLLBACK');console.error(e?.message||e);return err('تعذر حفظ إجابة التدريب',500)}finally{client.release()}
}
async function errorBank(studentId:string,url:URL){const {page:pg,pageSize}=page(url),offset=(pg-1)*pageSize;const [r,c]=await Promise.all([pool.query(`SELECT eb.question_id,q.stem,q.question_type,q.difficulty,eb.mistake_count,eb.correct_count,eb.last_mistake_at,eb.last_correct_at,(eb.mistake_count-eb.correct_count) weakness_score FROM student_error_bank eb JOIN questions q ON q.id=eb.question_id AND q.tenant_id=eb.tenant_id WHERE eb.tenant_id=$1 AND eb.student_id=$2 AND q.status='active' AND eb.mistake_count>0 ORDER BY weakness_score DESC,eb.last_mistake_at DESC NULLS LAST LIMIT $3 OFFSET $4`,[DEMO_TENANT_ID,studentId,pageSize,offset]),pool.query(`SELECT COUNT(*)::int total FROM student_error_bank WHERE tenant_id=$1 AND student_id=$2 AND mistake_count>0`,[DEMO_TENANT_ID,studentId])]);return json({items:r.rows,page:pg,pageSize,total:c.rows[0].total})}
async function skills(studentId:string){const r=await pool.query(`SELECT tn.id,tn.kind,tn.name,COUNT(*)::int touched_questions,SUM(eb.mistake_count)::int mistakes,SUM(eb.correct_count)::int corrects,ROUND((100.0*SUM(eb.correct_count)/NULLIF(SUM(eb.correct_count+eb.mistake_count),0))::numeric,2) accuracy FROM student_error_bank eb JOIN question_taxonomy qt ON qt.question_id=eb.question_id JOIN taxonomy_nodes tn ON tn.id=qt.taxonomy_id AND tn.tenant_id=eb.tenant_id WHERE eb.tenant_id=$1 AND eb.student_id=$2 GROUP BY tn.id,tn.kind,tn.name HAVING SUM(eb.correct_count+eb.mistake_count)>0 ORDER BY accuracy ASC NULLS FIRST,tn.name LIMIT 100`,[DEMO_TENANT_ID,studentId]);const rows=r.rows.map((x:any)=>({...x,accuracy:Number(x.accuracy??0)}));return json({weaknesses:rows.slice(0,10),strengths:[...rows].sort((a:any,b:any)=>b.accuracy-a.accuracy).slice(0,10)})}
async function dashboard(req:Request,studentId:string){const upstream=await fetch(BASE+'/api/v1/student/analytics/dashboard',{headers:{authorization:req.headers.get('authorization')||'',accept:'application/json'}});if(!upstream.ok)return new Response(await upstream.text(),{status:upstream.status,headers:{...cors,'content-type':upstream.headers.get('content-type')||'application/json'}});const d=await upstream.json();const tr=await pool.query(`SELECT COUNT(*)::int training_count,COUNT(*) FILTER(WHERE status='completed')::int completed_training FROM training_sessions WHERE tenant_id=$1 AND student_id=$2`,[DEMO_TENANT_ID,studentId]);d.summary={...(d.summary||{}),trainingCount:tr.rows[0]?.training_count??0,completedTraining:tr.rows[0]?.completed_training??0};return json(d)}
async function proxy(req:Request){const url=new URL(req.url);const target=BASE+url.pathname+url.search;const headers=new Headers(req.headers);headers.delete('host');const init:any={method:req.method,headers,redirect:'manual'};if(!['GET','HEAD'].includes(req.method))init.body=await req.arrayBuffer();const res=await fetch(target,init);const outHeaders=new Headers(res.headers);for(const [k,v] of Object.entries(cors))outHeaders.set(k,v);return new Response(res.body,{status:res.status,headers:outHeaders})}

export default {async fetch(req:Request){
  try{
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
    const url=new URL(req.url),p=url.pathname;
    const isStudentSpecial=p==='/api/v1/student/training'||/^\/api\/v1\/student\/training\/[^/]+(?:\/answer)?$/.test(p)||p==='/api/v1/student/error-bank'||p==='/api/v1/student/analytics/strengths-weaknesses'||p==='/api/v1/student/analytics/dashboard';
    if(!isStudentSpecial)return proxy(req);
    const studentId=await validStudent(req);if(!studentId)return err('غير مصرح',401);
    if(p==='/api/v1/student/training'&&req.method==='POST')return startTraining(req,studentId);
    let m=p.match(/^\/api\/v1\/student\/training\/([^/]+)$/);if(m&&req.method==='GET')return resumeTraining(studentId,m[1]);
    m=p.match(/^\/api\/v1\/student\/training\/([^/]+)\/answer$/);if(m&&req.method==='POST')return answerTraining(req,studentId,m[1]);
    if(p==='/api/v1/student/error-bank'&&req.method==='GET')return errorBank(studentId,url);
    if(p==='/api/v1/student/analytics/strengths-weaknesses'&&req.method==='GET')return skills(studentId);
    if(p==='/api/v1/student/analytics/dashboard'&&req.method==='GET')return dashboard(req,studentId);
    return proxy(req);
  }catch(e:any){console.error(e?.message||e);return err('خطأ داخلي في بوابة التجربة',500)}
}};
