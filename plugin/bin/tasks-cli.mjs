#!/usr/bin/env node
// @ts-check
// CLI cho agent-task-management. Cùng nghiệp vụ với MCP server, nhưng chạy tay được —
// vì lúc cần chẩn đoán nhất thường là lúc có gì đó hỏng, và khi đó không nên phải mở Claude Code.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { createRuntime } from '../lib/runtime.mjs';
import { createIngestRunner } from '../lib/ingest/run.mjs';
import { labelDefinitions, RETIRED_LABELS } from '../lib/schema.mjs';
import { findRepoRoot, claudeDirIsShared, CLONE_ENV_BASENAME } from '../lib/config.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const [, , cmd, ...rest] = process.argv;
const flag = (name) => rest.includes(`--${name}`);
const value = (name, def = null) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : def;
};

const USAGE = `agent-tasks CLI

  tasks-cli setup [--force]   MỘT LẦN CHO CẢ MÁY: tạo ~/.agent-tasks/{config.json,.env}
  tasks-cli init [--force]    TUỲ CHỌN, chỉ khi một dự án cần cấu hình khác cấp máy
  tasks-cli init --local [--force]
                              cấu hình của RIÊNG clone này vào <git-dir>/agent-tasks.env
                              (không commit được, không đụng .env của dự án)
  tasks-cli status            trạng thái cấu hình + claim của phiên này
  tasks-cli verify            kiểm 3 tiền đề: cấu hình · SSH claim-repo · token GitLab
  tasks-cli probe [--issue <iid>] [--write]
                              dò năng lực instance (version, tier, scoped label…)
  tasks-cli doctor [--fix]    chẩn đoán lệch giữa claim ref và nhãn GitLab
  tasks-cli claims [--all]    claim đang sống; --all = mọi dự án trên claim-repo này
  tasks-cli labels [--apply]  tạo bộ nhãn trên project (13 nhãn; mặc định chỉ in ra)
  tasks-cli labels --prune [--apply]
                              xoá các nhãn ĐÃ NGHỈ ở v0.2 (44 → 13). Không --apply thì chỉ liệt kê
  tasks-cli recap [--days 7] [--json]
                              N ngày qua: đã land gì · VÌ SAO · nợ kỹ thuật · bài học · đang ở đâu
  tasks-cli ingest [--apply] [--source spec|changelog|brief]
                              nhập tài liệu thành work item (MẶC ĐỊNH dry-run)

Một máy nhiều dự án: thứ DÙNG CHUNG (claim-repo, token) khai một lần ở
~/.agent-tasks/; còn gitlabHost + projectPath được ĐỌC từ git remote của từng dự án.
Nên một dự án mới KHÔNG cần file cấu hình nào. Khai tường minh vẫn luôn thắng.
`;

function requireReady(rt) {
  if (rt.configured) return true;
  console.error(`✗ chưa sẵn sàng: ${rt.reason}\n`);
  for (const w of rt.warnings ?? []) console.error(`  ⚠ ${w}`);
  process.exitCode = 2;
  return false;
}

const rt = createRuntime({ cwd: process.cwd(), env: process.env });

switch (cmd) {
  // `setup` — cấu hình CẤP MÁY, chạy một lần. Cũng phải chạy được khi chưa có gì.
  case 'setup': {
    const home = process.env.AGENT_TASKS_HOME || os.homedir();
    const dir = path.join(home, '.agent-tasks');
    const cfgFile = path.join(dir, 'config.json');
    const envFile = path.join(dir, '.env');

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Kiểm TỪNG file, không phải "có cái nào thì thôi".
    // Bản đầu dùng `existsSync(cfg) || existsSync(env)` rồi dừng cả lệnh: ai đã có config.json mà
    // thiếu .env sẽ bị kẹt — `setup` không tạo gì, mà `--force` thì ghi đè luôn cả config.json đã
    // điền. Thiếu cái nào thì tạo cái đó.
    if (fs.existsSync(cfgFile) && fs.existsSync(envFile) && !flag('force')) {
      console.log(`Cấu hình cấp máy đã đủ: ${dir}`);
      console.log('Không ghi đè (thêm --force nếu thật sự muốn thay).');
      console.log(`\nSửa tay rồi chạy: node bin/tasks-cli.mjs verify`);
      break;
    }

    // Backup TRƯỚC khi ghi đè: file này chứa token, mất là mất thật.
    for (const f of [cfgFile, envFile]) {
      if (fs.existsSync(f) && flag('force')) {
        fs.copyFileSync(f, `${f}.bak`);
        fs.chmodSync(`${f}.bak`, 0o600);
        console.log(`↩ đã lưu bản cũ: ${f}.bak`);
      }
    }

    if (!fs.existsSync(cfgFile) || flag('force')) {
      fs.writeFileSync(
        cfgFile,
        `${JSON.stringify(
          {
            // Chỉ hai thứ THẬT SỰ dùng chung. gitlabHost/projectPath cố ý KHÔNG có ở đây:
            // chúng được đọc từ git remote của từng dự án.
            claimRepoUrl: 'git@git.example.inc:grp/agent-claims.git',
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      console.log(`✓ đã tạo ${cfgFile}`);
    }

    if (!fs.existsSync(envFile) || flag('force')) {
      fs.writeFileSync(
        envFile,
        '# Token dùng chung cho MỌI dự án trên máy này. Quyền 600 — chỉ chủ máy đọc được.\n' +
          '# Dự án nào cần token khác: đặt GITLAB_TOKEN trong .env của dự án đó (tầng dưới thắng).\n' +
          'GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx\n',
        { mode: 0o600 },
      );
      console.log(`✓ đã tạo ${envFile} (quyền 600)`);
    }

    console.log('\nHai giá trị PHẢI điền:');
    console.log(`  claimRepoUrl   trong ${cfgFile}`);
    console.log(`  GITLAB_TOKEN   trong ${envFile}  (group access token, scope api)`);
    console.log('\nĐiền xong chạy: node bin/tasks-cli.mjs verify');
    console.log('Sau đó MỌI dự án trên máy dùng được, không cần cấu hình riêng.');
    break;
  }

  // `init` phải chạy được KHI CHƯA có cấu hình — nó chính là thứ tạo ra cấu hình.
  // Vì vậy nó đứng trước mọi requireReady().
  case 'init': {
    const { root, gitDir } = findRepoRoot(process.cwd());
    if (!root) {
      console.error(
        '✗ không tìm thấy .git khi đi ngược từ ' + process.cwd() + '\n' +
          '  agent-tasks định vị cấu hình theo root git. Chạy lại từ trong một git repo.',
      );
      process.exitCode = 2;
      break;
    }

    // ── `init --local`: cấu hình của RIÊNG clone này, đặt trong <git-dir>/ ──
    //
    // Tách hẳn khỏi `init` thường vì nó giải bài toán khác: `init` tạo `.env` ở ROOT — file mà cả
    // team thấy và ứng dụng cũng dùng. `--local` tạo file mà CHỈ clone này thấy, không đụng file
    // nào của dự án.
    if (flag('local')) {
      if (!gitDir) {
        console.error(
          `✗ tìm thấy root (${root}) nhưng không xác định được thư mục .git.\n` +
            '  Ca này xảy ra khi `.git` là file dị dạng. Không có chỗ an toàn để đặt cấu hình riêng.',
        );
        process.exitCode = 2;
        break;
      }

      // Cảnh báo TRƯỚC khi tạo file: người chạy lệnh này thường đang đứng trước đúng lựa chọn
      // "đặt vào .claude/ hay đặt vào .git/", nên đây là lúc câu trả lời có ích nhất.
      const shared = claudeDirIsShared(root);
      if (shared.shared) {
        console.log(`⚠️  .claude/ là symlink → ${shared.target}`);
        if (shared.others.length) {
          console.log(`    ${shared.others.length} dự án khác dùng chung: ${shared.others.join(', ')}`);
        }
        console.log(
          '    ⇒ KHÔNG đặt agent-tasks.config.json ở đó: mọi dự án dùng chung thư mục ấy sẽ\n' +
            '      đọc CÙNG một projectPath, work item sẽ ghi nhầm backlog.\n',
        );
      }

      const localDest = path.join(gitDir, CLONE_ENV_BASENAME);
      if (fs.existsSync(localDest) && !flag('force')) {
        console.log(`${CLONE_ENV_BASENAME} đã tồn tại: ${localDest}`);
        console.log('Không ghi đè (thêm --force nếu thật sự muốn thay).');
        break;
      }
      if (fs.existsSync(localDest) && flag('force')) {
        const backup = `${localDest}.bak`;
        fs.copyFileSync(localDest, backup);
        fs.chmodSync(backup, 0o600);
        console.log(`↩ đã lưu bản cũ: ${backup}`);
      }

      // Giá trị derive được đi vào COMMENT, không đi vào giá trị thật: điền thẳng là đóng băng
      // một thứ vốn tự đọc từ git remote, và lần đổi remote sau sẽ lệch mà không ai biết.
      const derivedProject = rt.config?.projectPath ?? '(chưa suy được từ git remote)';
      const derivedHost = rt.config?.gitlabHost ?? '(chưa suy được từ git remote)';
      const machineClaim = rt.config?.claimRepoUrl ?? '(chưa khai ở cấp máy)';

      fs.writeFileSync(
        localDest,
        `# agent-tasks — cấu hình của RIÊNG clone này (${root}).
#
# Vì sao file nằm ở đây chứ không ở chỗ khác:
#   • <git-dir>/ là thư mục thật của TỪNG clone — git không có đường nào track nội dung trong
#     đó, nên không thể commit nhầm token.
#   • KHÔNG dùng .claude/: thư mục đó rất hay là symlink dùng chung giữa nhiều dự án.
#   • KHÔNG dùng .env ở root: file đó thường là của ỨNG DỤNG và cả team dùng chung nội dung.
#
# Thứ tự: file này THẮNG .env của dự án và .env cấp máy, chỉ thua biến shell.
# Dòng nào để trống ⇒ kế thừa tầng trên. Xoá file ⇒ mọi thứ về y như trước.

# Token của riêng clone này. Để trống ⇒ dùng token cấp máy (~/.agent-tasks/.env).
GITLAB_TOKEN=

# Backlog — nơi chứa work item. Đang đọc từ git remote:
#   ${derivedProject}
#   ${derivedHost}
# Bỏ comment để ép khác đi:
# AGENT_TASKS_PROJECT_PATH=
# AGENT_TASKS_GITLAB_HOST=

# Claim-repo — nơi chứa ref khoá. Đang dùng của cấp máy:
#   ${machineClaim}
# AGENT_TASKS_CLAIM_REPO_URL=

# Các khoá còn lại (TTL, heartbeat, ingest, attach…): xem .env.example của agent-tasks.
`,
        { mode: 0o600 },
      );
      fs.chmodSync(localDest, 0o600);

      console.log(`✓ đã tạo ${localDest} (quyền 600)`);
      console.log(`    backlog       ${derivedProject}   ← từ git remote`);
      console.log(`    claim-repo    ${machineClaim}   ← cấp máy`);
      console.log('    token         (trống — kế thừa cấp máy; điền nếu clone này cần token riêng)');
      console.log('\nKHÔNG đụng .env của dự án. Sửa xong chạy: node bin/tasks-cli.mjs status');
      break;
    }

    const dest = path.join(root, '.env');
    const sample = path.join(PKG_ROOT, '.env.example');

    if (fs.existsSync(dest) && !flag('force')) {
      console.log(`.env đã tồn tại: ${dest}`);
      console.log('Không ghi đè (thêm --force nếu thật sự muốn thay).');
      console.log('\nSửa tay rồi chạy: node bin/tasks-cli.mjs verify');
      break;
    }

    let tpl;
    try {
      tpl = fs.readFileSync(sample, 'utf8');
    } catch {
      console.error(`✗ không đọc được bản mẫu ${sample} — cài đặt package bị thiếu file?`);
      process.exitCode = 2;
      break;
    }

    // Bảo vệ secret TRƯỚC khi ghi file có token: .env (và mọi biến thể) phải được gitignore.
    // Thứ tự quan trọng — ghi token ra đĩa rồi mới ignore là để hở một khoảng.
    const giPath = path.join(root, '.gitignore');
    let gi = '';
    try {
      gi = fs.readFileSync(giPath, 'utf8');
    } catch {
      /* chưa có .gitignore */
    }
    const lines = gi.split(/\r?\n/).map((l) => l.trim());
    // `.env` trần KHÔNG phủ `.env.bak` — nên phải kiểm riêng, đừng coi là xong.
    const envCovered = lines.some((l) => ['.env', '.env*', '*.env', '/.env'].includes(l));
    const bakCovered = lines.some((l) => ['.env*', '*.env', '.env.bak', '.env.*'].includes(l));

    if (!envCovered || !bakCovered) {
      fs.appendFileSync(
        giPath,
        `${gi && !gi.endsWith('\n') ? '\n' : ''}\n` +
          '# Cấu hình + token của từng máy — không commit.\n' +
          '# `.env*` phủ cả .env.bak (do `init --force` tạo) và .env.local.\n' +
          '.env*\n' +
          '!.env.example\n',
      );
      console.log(`✓ đã thêm \`.env*\` vào ${giPath} (các file này chứa token, không được commit)`);
    }

    if (fs.existsSync(dest) && flag('force')) {
      // Ghi đè cấu hình có token là mất dữ liệu thật. Giữ lại một bản — cũng quyền 600,
      // vì nó chứa đúng cái token vừa bị thay.
      const backup = `${dest}.bak`;
      fs.copyFileSync(dest, backup);
      fs.chmodSync(backup, 0o600);
      console.log(`↩ đã lưu bản cũ: ${backup}`);
    }

    fs.writeFileSync(dest, tpl, { mode: 0o600 });
    console.log(`✓ đã tạo ${dest} (quyền 600 — chỉ chủ máy đọc được)`);

    console.log('\nBa dòng BẮT BUỘC phải điền trong .env:');
    console.log('  AGENT_TASKS_GITLAB_HOST      https://git.example.inc');
    console.log('  AGENT_TASKS_PROJECT_PATH     grp/agent-backlog');
    console.log('  AGENT_TASKS_CLAIM_REPO_URL   git@git.example.inc:grp/agent-claims.git');
    console.log('  GITLAB_TOKEN                 group access token, scope api');
    console.log('\nĐiền xong chạy: node bin/tasks-cli.mjs verify');
    break;
  }

  case 'verify': {
    let bad = 0;

    // 1/3 — cấu hình nạp được chưa
    if (rt.configured) {
      console.log('✓ cấu hình   đã nạp đủ');
    } else {
      console.log(`✗ cấu hình   ${rt.reason}`);
      bad++;
    }

    // In NGUỒN của host + project ngay ở đây, không chỉ ở `status`.
    //
    // Đây là chỗ duy nhất bắt được ca "projectPath khai tường minh + gitlabHost suy từ remote của
    // một host KHÁC" — cấu hình không cảnh báo được ca đó (không có gì để so), nhưng `verify` gọi
    // API thật nên 404/401 sẽ lộ. Người đọc cần thấy hai giá trị đến từ hai nguồn để hiểu vì sao.
    {
      const src = (rt.sources ?? []).find((s) => s.layer === 'git-remote');
      const from = (key) =>
        src?.filled?.includes(key) ? `git remote "${src.remote}"` : 'khai tường minh';
      console.log(`  gitlab     ${rt.config?.gitlabHost ?? '-'}   ← ${from('gitlabHost')}`);
      console.log(`  project    ${rt.config?.projectPath ?? '-'}   ← ${from('projectPath')}`);
    }

    for (const w of rt.warnings ?? []) console.log(`  ⚠ ${w}`);

    const claimUrl = rt.config?.claimRepoUrl;

    // 2/3 — SSH tới claim-repo. Đây là đường claim đi, KHÔNG phải API.
    if (!claimUrl) {
      console.log('· claim-repo chưa khai AGENT_TASKS_CLAIM_REPO_URL — bỏ qua');
    } else {
      try {
        execFileSync('git', ['ls-remote', claimUrl, 'refs/claims/*'], {
          stdio: 'pipe',
          timeout: 20000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' },
        });
        console.log(`✓ claim-repo SSH đọc/ghi được — ${claimUrl}`);
      } catch (err) {
        const msg = String(err.stderr ?? err.message ?? '').trim().split('\n').slice(-2).join(' ');
        console.log(`✗ claim-repo KHÔNG với tới được — ${claimUrl}\n  ${msg}`);
        console.log(
          '  Claim đi qua git-over-ssh, không qua API. Kiểm: git ls-remote ' + claimUrl,
        );
        bad++;
      }
    }

    // 3/3 — token sống, và project backlog bật Issues
    if (!rt.gitlab) {
      console.log('· token      chưa đủ cấu hình để thử gọi GitLab — bỏ qua');
    } else {
      try {
        const me = await rt.gitlab.whoami();
        console.log(`✓ token      sống — ${me.username}${me.bot ? ' (bot)' : ''}`);
      } catch (err) {
        console.log(`✗ token      gọi /user thất bại — ${err.message}`);
        console.log('  401 ⇒ token sai hoặc hết hạn. 403 ⇒ thiếu scope `api`.');
        bad++;
      }
      try {
        const p = await rt.gitlab.getProject();
        if (p.issues_enabled === false) {
          console.log(`✗ backlog    ${p.path_with_namespace} có Issues BỊ TẮT — phải bật mới dùng được`);
          bad++;
        } else {
          console.log(`✓ backlog    ${p.path_with_namespace} · Issues đang bật`);
        }
      } catch (err) {
        console.log(`✗ backlog    không đọc được project — ${err.message}`);
        console.log('  404 ⇒ sai AGENT_TASKS_PROJECT_PATH, hoặc token không thấy project này.');
        bad++;
      }
    }

    if (bad) {
      console.log(`\n✗ còn ${bad} việc phải sửa trước khi chạy labels/ingest.`);
      process.exitCode = 2;
    } else {
      console.log('\n✓ sẵn sàng. Bước kế: node bin/tasks-cli.mjs labels --apply');
    }
    break;
  }

  case 'status': {
    console.log(`root:        ${rt.root ?? '(không xác định)'}`);
    console.log(`cấu hình:    ${rt.configured ? '✓ sẵn sàng' : `✗ ${rt.reason}`}`);
    console.log(`gitlab:      ${rt.config?.gitlabHost ?? '-'} / ${rt.config?.projectPath ?? '-'}`);
    console.log(`claim-repo:  ${rt.config?.claimRepoUrl ?? '-'}`);
    console.log(`projectKey:  ${rt.config?.projectKey ?? '-'}`);
    console.log(`ttl/hb:      ${rt.config?.ttlSec}s / ${rt.config?.heartbeatSec}s`);
    if (rt.identity) {
      console.log(`phiên:       ${rt.identity.owner}@${rt.identity.host} · session ${rt.identity.sessionId}`);
    }

    // Truy vết nguồn: khi giá trị không như mong đợi, câu hỏi đầu tiên luôn là "đọc từ đâu".
    // Với một máy nhiều dự án thì câu đó còn quan trọng hơn — hai dự án cùng máy có thể lấy giá
    // trị từ hai nơi khác nhau, và `status` là chỗ duy nhất nói ra được.
    const loadedFrom = (rt.sources ?? []).filter((s) => s.loaded && s.path);
    console.log(
      `nguồn:       ${loadedFrom.length ? loadedFrom.map((s) => s.layer).join(' → ') : '(chỉ mặc định)'}`,
    );
    for (const s of loadedFrom) console.log(`               ${s.layer}: ${s.path}`);

    const remoteSrc = (rt.sources ?? []).find((s) => s.layer === 'git-remote');
    if (remoteSrc?.filled?.length) {
      console.log(
        `từ git remote: ${remoteSrc.filled.join(', ')} (remote "${remoteSrc.remote}") ` +
          `— không ai khai nên đọc từ đó`,
      );
    } else if (remoteSrc && !remoteSrc.loaded) {
      console.log('từ git remote: KHÔNG suy được — xem cảnh báo bên dưới');
    }

    if (rt.envApplied?.length) {
      console.log(`từ .env/env: ${rt.envApplied.join(', ')}`);
    }

    for (const w of rt.warnings ?? []) console.log(`  ⚠ ${w}`);
    break;
  }

  case 'claims': {
    if (!requireReady(rt)) break;
    const everywhere = flag('all');
    const all = rt.claims.list({ allProjects: everywhere });
    if (!all.length) {
      console.log(
        everywhere
          ? 'Không có claim nào đang sống trên claim-repo này (mọi dự án).'
          : `Không có claim nào đang sống cho ${rt.config.projectPath}. Thêm --all để xem mọi dự án.`,
      );
      break;
    }
    if (everywhere) {
      // ⚠️ Che credential: claim-repo thường là SSH, nhưng ai dùng dạng
      // `https://oauth2:<token>@host/...` thì in nguyên văn là in token ra màn hình và log.
      // Cùng luật với git-remote.mjs — URL lọt vào log là token lọt theo.
      const safeUrl = String(rt.config.claimRepoUrl ?? '').replace(/\/\/[^/@]*@/, '//***@');
      console.log(`Mọi dự án dùng claim-repo ${safeUrl}:\n`);
    }
    for (const c of all) {
      const left = Math.round((Date.parse(c.expires_at) - Date.now()) / 1000);
      const mine = c.owner_id === rt.claims.ownerId ? ' ← phiên này' : '';
      console.log(`${c.item}\n  ${c.owner}@${c.host} · còn ${left}s${mine}`);
    }
    if (all.skipped) {
      console.log(`\n⚠️ ${all.skipped} ref không đọc được — danh sách trên THIẾU. Chạy doctor.`);
    }
    break;
  }

  case 'probe': {
    if (!requireReady(rt)) break;

    const iid = value('issue');
    const r = await rt.probe.run({
      probe_issue_iid: iid == null ? null : Number(iid),
      write: flag('write'),
    });

    // In `null` thành "chưa dò được", KHÔNG thành "không". Đó là toàn bộ điểm của tool này: một
    // `false` sai làm server mô phỏng scoped label vĩnh viễn trên instance vốn hỗ trợ sẵn.
    const yn = (v) => (v === null || v === undefined ? '? chưa dò được' : v ? '✓ có' : '· không');

    console.log(`instance:    ${r.host ?? '-'} · ${r.project_path ?? '-'}`);
    console.log(`version:     ${r.version ?? '(chưa dò được)'}${r.edition ? ` · ${r.edition.toUpperCase()}` : ''}`);
    console.log(`tier (đoán): ${r.tier_guess}`);
    console.log(`scoped label       ${yn(r.scoped_labels)}`);
    console.log(`work items GraphQL ${yn(r.work_items_graphql)}`);
    console.log(`custom fields      ${yn(r.custom_fields)}`);
    console.log(`Query.epic đã xoá  ${yn(r.epic_graphql_removed)}`);
    console.log(`rate limit         ${yn(r.rate_limit_enabled)}`);

    if (r.inferred?.length) {
      console.log('\nSuy ra (không phải đo được):');
      for (const i of r.inferred) console.log(`  • ${i}`);
    }
    if (r.unverified?.length) {
      console.log(`\n⚠️ CHƯA DÒ ĐƯỢC — ${r.unverified.length} mục:`);
      for (const u of r.unverified) console.log(`  • ${u}`);
    }
    if (r.leftovers?.length) {
      console.log('\n🗑 RÁC CÒN LẠI trên GitLab — phải dọn tay:');
      for (const l of r.leftovers) console.log(`  • ${l}`);
      process.exitCode = 2;
    }

    console.log(`\n${r.written ? '✓' : '·'} ${r.next}`);
    if (r.write_error) {
      console.log(`✗ ${r.write_error}`);
      process.exitCode = 2;
    }
    // Không dò được trường nào ⇒ lệnh THẤT BẠI, dù nó đã in ra một bảng đầy đủ. Exit 0 ở đây làm
    // script cài đặt đi tiếp như thể đã dò xong.
    if (r.measured === 0) process.exitCode = 2;
    break;
  }

  case 'doctor': {
    if (!requireReady(rt)) break;
    const r = await rt.handlers.tasks_doctor({ fix: flag('fix') });
    const out = r.structuredContent ?? {};
    if (!out.findings?.length) { console.log('✓ không phát hiện lệch nào.'); break; }
    console.log(`Phát hiện ${out.findings.length} vấn đề${out.fixed ? ' (đã thử sửa)' : ' (chỉ đọc — thêm --fix để sửa)'}:\n`);
    for (const f of out.findings) console.log(`  • [${f.kind}] ${f.iid ?? f.item} — ${f.note ?? ''}`);
    break;
  }

  case 'labels': {
    const defs = labelDefinitions();

    // `--prune` là đường DỌN sau khi bộ nhãn xuống 44 → 13 ở v0.2. Nó xoá theo DANH SÁCH TƯỜNG
    // MINH `RETIRED_LABELS`, không xoá "mọi nhãn không nằm trong bộ mới": project của người ta có
    // nhãn riêng của họ (`ưu tiên::cao`, tên sprint, tên team), và xoá theo phép trừ là xoá cả
    // những nhãn đó. Xoá nhãn trên GitLab cũng gỡ nó khỏi mọi issue — không lùi được.
    if (flag('prune')) {
      if (!requireReady(rt)) break;
      const existing = new Set((await rt.gitlab.listLabels()).map((l) => l.name));
      const present = RETIRED_LABELS.filter((n) => existing.has(n));

      if (!present.length) {
        console.log(`✓ không còn nhãn nào thuộc diện đã nghỉ (đã kiểm ${RETIRED_LABELS.length} tên).`);
        break;
      }
      if (!flag('apply')) {
        console.log(
          `${present.length}/${RETIRED_LABELS.length} nhãn đã nghỉ CÒN TỒN TẠI trên project.\n` +
            `Xoá nhãn cũng gỡ nó khỏi mọi issue đang mang — KHÔNG LÙI ĐƯỢC.\n` +
            `Thêm --apply để xoá thật:\n`,
        );
        for (const n of present) console.log(`  ${n}`);
        break;
      }
      let gone = 0;
      for (const n of present) {
        try {
          await rt.gitlab.deleteLabel(n);
          gone++;
        } catch (err) {
          console.error(`  ✗ ${n}: ${err.message}`);
          process.exitCode = 2;
        }
      }
      console.log(`✓ đã xoá ${gone}/${present.length} nhãn đã nghỉ.`);
      break;
    }

    if (!flag('apply')) {
      console.log(`${defs.length} nhãn sẽ được tạo (thêm --apply để ghi thật):\n`);
      for (const d of defs) console.log(`  ${d.color}  ${d.name.padEnd(18)} ${d.description}`);
      break;
    }
    if (!requireReady(rt)) break;
    let created = 0;
    let existed = 0;
    for (const d of defs) {
      const r = await rt.gitlab.createLabel(d);
      r.existed ? existed++ : created++;
    }
    console.log(`✓ tạo mới ${created}, đã có sẵn ${existed}.`);
    console.log(`\nBộ nhãn v0.2 có 13 nhãn. Project nâng cấp từ 0.1.x còn ${RETIRED_LABELS.length} tên đã nghỉ —`);
    console.log('dọn bằng: tasks-cli labels --prune   (xem trước), rồi --prune --apply');
    break;
  }

  // Recap N ngày — CÙNG LÕI với tool MCP `tasks_recap`, khác vỏ. Vỏ CLI tồn tại để người trong
  // dự án đọc được bối cảnh mà KHÔNG cần mở Claude: đó là nửa "human vẫn audit được" của yêu cầu.
  case 'recap': {
    if (!requireReady(rt)) break;
    const days = Number(value('days', '7'));
    if (!Number.isFinite(days) || days < 1) {
      console.error(`✗ --days cần một số ≥ 1 (nhận được "${value('days')}")`);
      process.exitCode = 1;
      break;
    }
    const r = await rt.handlers.tasks_recap({ days });
    if (r.isError) {
      console.error(r.content?.[0]?.text ?? 'recap lỗi');
      process.exitCode = 2;
      break;
    }
    if (flag('json')) {
      console.log(JSON.stringify(r.structuredContent ?? {}, null, 2));
      break;
    }
    console.log(r.content?.[0]?.text ?? '');
    // Nguồn không đọc được ⇒ exit ≠ 0. Bản recap vẫn in ra (nó có ích), nhưng script CI hay
    // người gọi trong pipeline phải biết bản này KHÔNG đầy đủ.
    const s = r.structuredContent?.sources ?? {};
    if (s.changelog === null || s.knowledge === null || s.open_debt === null) process.exitCode = 3;
    break;
  }

  case 'ingest': {
    if (!requireReady(rt)) break;
    const runner = createIngestRunner({ root: rt.root, gitlab: rt.gitlab, config: rt.config });
    const src = value('source');
    const r = await runner.run({ sources: src ? [src] : undefined, dryRun: !flag('apply') });

    console.log(`Nguồn: ${r.enabled.join(', ')} · tổng ${r.total} mục\n`);
    console.log('Hành động   Số lượng');
    for (const [k, v] of Object.entries(r.counts)) console.log(`  ${k.padEnd(20)} ${v}`);

    if (r.debt.length) {
      console.log(`\n⚠️ NỢ METADATA — ${r.debt.length} mục thiếu trường:\n`);
      for (const d of r.debt.slice(0, 25)) console.log(`  ${d.key}\n    ↳ ${d.debt.join('\n    ↳ ')}`);
      if (r.debt.length > 25) console.log(`  … và ${r.debt.length - 25} mục nữa`);
    }

    console.log(
      r.dryRun
        ? `\nChưa ghi gì. Chạy lại với --apply để thực hiện. (run id sẽ là ${r.runId})`
        : `\n✓ đã áp dụng ${r.applied.length} thao tác · run ${r.runId}`,
    );
    break;
  }

  default:
    console.log(USAGE);
    if (cmd) process.exitCode = 1;
}
