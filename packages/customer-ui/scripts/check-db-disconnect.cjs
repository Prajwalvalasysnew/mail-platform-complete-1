// Separate local test process: only its own connections are timed out.
const assert=require('node:assert/strict');
if(process.env.NODE_ENV==='production'||process.env.DELIVERY_TRANSPORT!=='mailpit')throw new Error('Local Mailpit environment required');
process.env.PG_IDLE_TX_TIMEOUT_MS='500';
const {getPool,closeQueues,closeRedis}=require('/app/packages/shared/dist/index.js');
async function main(){try{
 const pool=getPool(),active=await pool.connect();
 await active.query('BEGIN');await new Promise(resolve=>setTimeout(resolve,1000));
 await assert.rejects(active.query('SELECT 1'));active.release(true);
 assert.equal((await pool.query('SELECT 1 AS n')).rows[0].n,1);
 const idle=await pool.connect();await idle.query('BEGIN');idle.release();
 await new Promise(resolve=>setTimeout(resolve,1000));
 assert.equal((await pool.query('SELECT 1 AS n')).rows[0].n,1);
 console.log('PASS checked-out and idle connection termination do not crash the process; broken queries reject and new connections recover');
 }finally{await closeQueues();await closeRedis();await getPool().end();}}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
