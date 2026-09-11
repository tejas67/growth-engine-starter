import dotenv from 'dotenv';
import pg from 'pg';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
dotenv.config();
const source=process.env.GROWTH_DATABASE_URL;
if(!source)throw new Error('Run npm run setup and npm run db:up first, or provide a local GROWTH_DATABASE_URL.');
const url=new URL(source);
if(!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('Integration tests require a local database server.');
const name='growth_test_'+randomBytes(8).toString('hex');
url.pathname='/postgres';const admin=new pg.Client({connectionString:url.href});await admin.connect();
try {
  await admin.query(`CREATE DATABASE ${name}`);url.pathname='/'+name;
  const env={...process.env,GROWTH_DATABASE_URL:url.href,GROWTH_INTEGRATION_TESTS:'1'};
  const result=spawnSync('npm',['exec','--','vitest','run','tests/standalone.database.test.ts'],{env,stdio:'inherit'});
  process.exitCode=result.status ?? 1;
} finally {await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();}
