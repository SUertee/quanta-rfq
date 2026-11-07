import {spawnSync} from 'node:child_process';
const scripts=['test-agent-mvp','test-merged-workbench','test-intake','test-workflow','test-agent-audit','test-agent-scope','test-quote-receipt','verify-agent-ui','test-run-audit','test-chat-files','test-chat-previews','test-chat-stream','test-conversations','test-floating-assistant','test-stage-navigation','verify-quote-export','test-ui-dom','test-landing-entry'];
for(const script of scripts){console.log(`\n[check] ${script}`);const result=spawnSync(process.execPath,[`scripts/${script}.mjs`],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}
console.log(`\nPASS: ${scripts.length} offline validation scripts (no model credentials required)`);
