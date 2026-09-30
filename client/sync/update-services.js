import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { inspectUpstream, upstreamPrefix } from './upstream.js';

const ps = value => "'" + String(value).replaceAll("'", "''") + "'";
const real = path => { try { return realpathSync(path); } catch { return path; } };

// Official CLI defaults to serve when omitted. Accept only known server options.
function serves(args) {
  let command = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'serve' && !command) { command = true; continue; }
    if (arg === '--no-open') continue;
    if (arg === '--port' || arg === '-p') {
      const port = Number(args[++i]);
      if (Number.isInteger(port) && port > 0 && port < 65536) continue;
    }
    return false;
  }
  return true;
}

function collectorFromLaunch(config) {
  const args = config.ProgramArguments;
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) return null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const path = isAbsolute(arg) ? arg : isAbsolute(config.WorkingDirectory || '') ? resolve(config.WorkingDirectory, arg) : null;
    const found = path && inspectUpstream(path);
    // An arbitrary JS file inside an official package is not its declared CLI.
    if (found && real(path) === found.entry && serves(args.slice(index + 1))) return found;
  }
  return null;
}

/** Only stop services whose saved executable is verified, retaining all launch settings. */
export function updateServices({ home, dir, platform, found, runner, log = () => {} }) {
  const collector = [], sync = [];
  const syncEntry = join(dir, 'app/bin/tokenrank.js');
  const syncPackage = JSON.parse(readFileSync(join(dir, 'app/package.json'), 'utf8'));
  if (syncPackage.name !== 'tokenrank-client' || !existsSync(syncEntry)) throw new Error('请先通过小程序接入命令安装独立同步器');
  if (platform === 'darwin') {
    const candidates = [];
    for (const label of ['com.tokenwatcher.server', 'com.tokenmeter.server', 'com.tokenrank.sync']) {
      const file = join(home, 'Library/LaunchAgents', label + '.plist');
      if (!existsSync(file)) continue;
      const config = JSON.parse(runner('plutil', ['-convert', 'json', '-o', '-', file]));
      const args = config.ProgramArguments || [], isSync = label === 'com.tokenrank.sync';
      if (config.Label !== label) throw new Error(`${label} 的名称与配置不一致，尚未更改程序或数据`);
      const target = `gui/${process.getuid()}/${label}`;
      const loaded = () => {
        try { runner('launchctl', ['print', target]); return true; }
        catch (err) {
          if (err.status === 113 || /Could not find (?:specified )?service/i.test(String(err.stderr || ''))) return false;
          throw new Error(`无法读取 ${label} 的运行状态，尚未操作该服务`);
        }
      };
      const active = loaded();
      const original = isSync ? null : collectorFromLaunch(config);
      const valid = isSync ? args.some(arg => real(arg) === real(syncEntry)) && args.includes('watch') : !!original;
      if (!valid) {
        // A dormant legacy plist is not a running collector. Never start or remove it.
        if (!isSync && !active) { log(`跳过未加载且无法核实的历史服务 ${label}，保留其配置。`); continue; }
        throw new Error(`无法确认 ${label} 的启动入口。请提供只读检查结果：plutil -extract ProgramArguments json -o - "${file}"；尚未更改程序或数据`);
      }
      const service = { name: label,
        stop() { if (loaded()) runner('launchctl', ['bootout', target]); },
        start() { if (!loaded()) runner('launchctl', ['bootstrap', `gui/${process.getuid()}`, file]); },
        check() { const status = String(runner('launchctl', ['print', target])); return /\bpid = \d+/.test(status); },
      };
      if (isSync) sync.push(service);
      else candidates.push({ original, active, service });
    }
    const active = candidates.filter(item => item.active);
    if (active.length > 1) throw new Error('检测到两套同时加载的原版采集后台，请先确认保留哪一套；尚未更改程序或数据');
    const selected = active[0] || candidates.find(item => item.original.entry === real(found.entry)) || (candidates.length === 1 ? candidates[0] : null);
    if (selected) {
      if (selected.original.entry !== real(found.entry)) log('检测到后台使用另一处原版安装，按实际服务入口更新。');
      found = selected.original;
      collector.push(selected.service);
    }
  } else if (platform === 'linux') {
    for (const [name, entry, list] of [
      ['token-watcher-for-tokenrank.service', found.entry, collector], ['tokenrank-sync.service', syncEntry, sync],
    ]) {
      const file = join(home, '.config/systemd/user', name);
      if (!existsSync(file)) continue;
      const quote = s => String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
      const text = readFileSync(file, 'utf8');
      if (!text.split('\n').some(line => line.startsWith('ExecStart=') && line.includes(`"${quote(entry)}"`)))
        throw new Error(`无法确认 ${name} 的归属，尚未更改程序或数据`);
      const effective = String(runner('systemctl', ['--user', 'show', name, '--property=ExecStart', '--value']));
      if (!effective.includes(entry)) throw new Error(`${name} 的实际配置与文件不一致`);
      list.push({ name, stop() { runner('systemctl', ['--user', 'stop', name]); },
        start() { runner('systemctl', ['--user', 'start', name]); },
        check() { try { runner('systemctl', ['--user', 'is-active', '--quiet', name]); return true; } catch { return false; } } });
    }
  } else if (platform === 'win32') {
    for (const [name, file, entry, list] of [
      ['TokenWatcherForTokenRank', join(upstreamPrefix(home, platform), 'collector.vbs'), found.entry, collector],
      ['TokenRankSync', join(dir, 'sync.vbs'), syncEntry, sync],
    ]) {
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file), text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString('utf16le') : bytes.toString('utf8');
      if (!text.includes(entry.replaceAll('"', '""'))) throw new Error(`无法确认 ${name} 的脚本归属`);
      const powershell = command => runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + command]);
      const task = JSON.parse(powershell(`Get-ScheduledTask -TaskName ${ps(name)} | Select-Object -ExpandProperty Actions | ConvertTo-Json -Compress`));
      if (Array.isArray(task) || !/wscript(?:\.exe)?$/i.test(task.Execute) || task.Arguments !== `"${file}"`)
        throw new Error(`无法确认 ${name} 的计划任务归属`);
      const processes = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('"' + ${ps(entry)} + '"') }`;
      list.push({ name,
        stop() { powershell(`Stop-ScheduledTask -TaskName ${ps(name)}; ${processes} | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }`); },
        start() { powershell(`Start-ScheduledTask -TaskName ${ps(name)}`); },
        check() { return Number(String(powershell(`@(${processes}).Count`)).trim()) > 0; },
      });
    }
  } else throw new Error('更新命令支持 macOS、Windows 和使用 systemd 的 Linux');
  if (!collector.length || !sync.length) throw new Error('未找到可验证的采集和同步后台。请先完成小程序一键接入；自定义后台需先按其启动方式升级');
  return { collector, sync, found };
}

/** After stopping the verified services, refuse any remaining original collector/CLI. */
export function assertCollectorStopped({ platform, found, runner }) {
  if (platform === 'win32') {
    const output = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${ps(found.entry)}) }).Count`]);
    if (Number(String(output).trim()) !== 0) throw new Error('仍有原版进程在运行，请退出手动启动的采集进程后重试');
  } else {
    const output = String(runner('ps', ['-axo', 'pid=,args=']));
    if (output.split('\n').some(line => line.includes(found.entry))) throw new Error('仍有原版进程在运行，请退出手动启动的采集进程后重试');
  }
}
