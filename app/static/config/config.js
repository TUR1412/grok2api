let apiKey = '';
let currentConfig = {};
const NUMERIC_FIELDS = new Set([
  'timeout',
  'max_retry',
  'retry_backoff_base',
  'retry_backoff_factor',
  'retry_backoff_max',
  'retry_budget',
  'refresh_interval_hours',
  'super_refresh_interval_hours',
  'fail_threshold',
  'nsfw_refresh_concurrency',
  'nsfw_refresh_retries',
  'limit_mb',
  'save_delay_ms',
  'usage_flush_interval_sec',
  'assets_max_concurrent',
  'media_max_concurrent',
  'usage_max_concurrent',
  'assets_delete_batch_size',
  'admin_assets_batch_size',
  'reload_interval_sec',
  'stream_timeout',
  'final_timeout',
  'blocked_grace_seconds',
  'medium_min_bytes',
  'final_min_bytes',
  'blocked_parallel_attempts',
  'concurrent',
  'solver_threads',
  'register_threads',
  'default_count'
]);

const LOCALE_MAP = {
  "app": {
    "label": "应用设置",
    "api_key": { title: "API 密钥", desc: "调用 Grok2API 服务所需的 Bearer Token，请妥善保管。" },
    "admin_username": { title: "后台账号", desc: "登录 Grok2API 服务管理后台的用户名，默认 admin。" },
    "app_key": { title: "后台密码", desc: "登录 Grok2API 服务管理后台的密码，请妥善保管。" },
    "app_url": { title: "应用地址", desc: "当前 Grok2API 服务的外部访问 URL，用于文件链接访问。" },
    "image_format": { title: "图片格式", desc: "生成的图片格式（url / base64 / b64_json）。" },
    "video_format": { title: "视频格式", desc: "视频返回格式（html / url）。" },
    "disable_memory": { title: "禁用记忆", desc: "禁用 Grok 记忆功能，防止响应中出现不相关上下文。" },
    "custom_instruction": { title: "自定义指令", desc: "透传为 Grok customPersonality 的多行自定义指令。" }
  },
  "grok": {
    "label": "Grok 设置",
    "temporary": { title: "临时对话", desc: "是否启用临时对话模式。" },
    "stream": { title: "流式响应", desc: "是否默认启用流式输出。" },
    "thinking": { title: "思维链", desc: "是否启用模型思维链输出。" },
    "dynamic_statsig": { title: "动态指纹", desc: "是否启用动态生成 Statsig 值。" },
    "filter_tags": { title: "过滤标签", desc: "自动过滤 Grok 响应中的特殊标签。" },
    "video_poster_preview": { title: "视频海报预览", desc: "启用后会将返回内容中的 <video> 标签替换为带播放按钮的 Poster 预览图；点击预览图会在新标签页打开视频（默认关闭）。" },
    "timeout": { title: "超时时间", desc: "请求 Grok 服务的超时时间（秒）。" },
    "base_proxy_url": { title: "基础代理 URL", desc: "代理请求到 Grok 官网的基础服务地址。" },
    "asset_proxy_url": { title: "资源代理 URL", desc: "代理请求到 Grok 官网的静态资源（图片/视频）地址。" },
    "cf_cookies": { title: "CF Cookies", desc: "完整的 Cloudflare Cookies 字符串；会和 cf_clearance 一起拼接使用。" },
    "cf_clearance": { title: "CF Clearance", desc: "Cloudflare 验证 Cookie，用于验证 Cloudflare 的验证。" },
    "skip_proxy_ssl_verify": { title: "跳过代理 SSL 校验", desc: "仅在代理证书自签名时开启；Workers 侧当前只保留配置语义。" },
    "max_retry": { title: "最大重试", desc: "请求 Grok 服务失败时的最大重试次数。" },
    "retry_status_codes": { title: "重试状态码", desc: "触发重试的 HTTP 状态码列表。" },
    "reset_session_status_codes": { title: "重建会话状态码", desc: "命中这些状态码时，后续重试会视为需要重建会话的错误。" },
    "retry_backoff_base": { title: "退避基数", desc: "重试退避的基础延迟（秒）。" },
    "retry_backoff_factor": { title: "退避倍率", desc: "重试退避的指数放大系数。" },
    "retry_backoff_max": { title: "退避上限", desc: "单次重试等待的最大延迟（秒）。" },
    "retry_budget": { title: "退避预算", desc: "单次请求允许重试的总预算时长（秒）。" },
    "image_generation_method": { title: "生图调用方式", desc: "旧方法稳定；新方法为实验性方法。" }
  },
  "token": {
    "label": "Token 池设置",
    "auto_refresh": { title: "自动刷新", desc: "是否开启 Token 自动刷新机制。" },
    "refresh_interval_hours": { title: "刷新间隔", desc: "Token 刷新的时间间隔（小时）。" },
    "super_refresh_interval_hours": { title: "Super 刷新间隔", desc: "Super Token 刷新的时间间隔（小时）。" },
    "fail_threshold": { title: "失败阈值", desc: "单个 Token 连续失败多少次后标记为不可用。" },
    "nsfw_refresh_concurrency": { title: "NSFW 刷新并发", desc: "账户设置刷新（协议/年龄/NSFW）时的默认并发数。" },
    "nsfw_refresh_retries": { title: "NSFW 刷新重试", desc: "账户设置刷新失败后的额外重试次数（不含首次）。" },
    "save_delay_ms": { title: "保存延迟", desc: "Token 变更合并写入的延迟（毫秒）。" },
    "usage_flush_interval_sec": { title: "用量落库间隔", desc: "用量类字段写入存储的最小间隔（秒）。" },
    "reload_interval_sec": { title: "一致性刷新", desc: "多 worker 场景下 Token 状态刷新间隔（秒）。" }
  },
  "cache": {
    "label": "缓存设置",
    "enable_auto_clean": { title: "自动清理", desc: "是否启用缓存自动清理，开启后按上限自动回收。" },
    "limit_mb": { title: "清理阈值", desc: "缓存大小阈值（MB），超过阈值会触发清理。" }
  },
  "image": {
    "label": "图像设置",
    "timeout": { title: "请求超时", desc: "图像请求总超时时间（秒）。" },
    "stream_timeout": { title: "流空闲超时", desc: "图像 websocket / 流式空闲超时时间（秒）。" },
    "final_timeout": { title: "最终图超时", desc: "收到中图后等待最终图的超时秒数。" },
    "blocked_grace_seconds": { title: "审查宽限秒数", desc: "收到中图后，判定疑似被审查/拦截的宽限秒数。" },
    "nsfw": { title: "NSFW 模式", desc: "图像链路是否优先按 NSFW 能力挑选 token。" },
    "medium_min_bytes": { title: "中图最小字节", desc: "判定中等质量图的最小字节数。" },
    "final_min_bytes": { title: "最终图最小字节", desc: "判定最终图的最小字节数。" },
    "blocked_parallel_attempts": { title: "并行补偿次数", desc: "遇到疑似审查/拦截时的额外补偿尝试次数。" },
    "blocked_parallel_enabled": { title: "并行补偿开关", desc: "是否启用并行补偿恢复。" }
  },
  "video": {
    "label": "视频设置",
    "concurrent": { title: "视频并发", desc: "视频链路的并发上限。" },
    "timeout": { title: "请求超时", desc: "视频请求总超时时间（秒）。" },
    "stream_timeout": { title: "流空闲超时", desc: "视频流式空闲超时时间（秒）。" },
    "upscale_timing": { title: "超分时机", desc: "720p 生成时的超分时机（single / complete）。" }
  },
  "performance": {
    "label": "并发性能",
    "assets_max_concurrent": { title: "资产并发上限", desc: "资源上传/下载/列表的并发上限。推荐 25。" },
    "media_max_concurrent": { title: "媒体并发上限", desc: "视频/媒体生成请求的并发上限。推荐 50。" },
    "usage_max_concurrent": { title: "用量并发上限", desc: "用量查询请求的并发上限。推荐 25。" },
    "assets_delete_batch_size": { title: "资产清理批量", desc: "在线资产删除单批并发数量。推荐 10。" },
    "admin_assets_batch_size": { title: "管理端批量", desc: "管理端在线资产统计/清理批量并发数量。推荐 10。" }
  },
  "register": {
    "label": "自动注册",
    "worker_domain": { title: "Worker 域名", desc: "临时邮箱 Worker 的域名（不含 https://）。" },
    "email_domain": { title: "邮箱域名", desc: "临时邮箱使用的域名，如 example.com。" },
    "admin_password": { title: "邮箱管理密码", desc: "Worker 后台的管理密钥。" },
    "yescaptcha_key": { title: "YesCaptcha Key", desc: "可选。填写后优先使用 YesCaptcha。" },
    "solver_url": { title: "Solver 地址", desc: "本地 Turnstile Solver 地址，默认 http://127.0.0.1:5072。" },
    "solver_browser_type": { title: "Solver 浏览器", desc: "Solver 使用的浏览器类型：chromium / chrome / msedge / camoufox。建议使用 camoufox（对 accounts.x.ai 成功率更高）。" },
    "solver_threads": { title: "Solver 线程数", desc: "自动启动 Solver 时的线程数，默认 5。" },
    "register_threads": { title: "注册线程数", desc: "注册并发线程数，默认 10。" },
    "default_count": { title: "默认注册数量", desc: "未填写数量时默认注册多少个，默认 100。" },
    "auto_start_solver": { title: "自动启动 Solver", desc: "注册时自动启动本地 Solver。" },
    "solver_debug": { title: "Solver 调试", desc: "启动 Solver 时开启调试日志。" },
    "max_errors": { title: "最大错误数", desc: "失败次数超过阈值会自动停止注册。0 表示自动计算。"},
    "max_runtime_minutes": { title: "最长运行时间(分钟)", desc: "超过指定分钟数后自动停止注册。0 表示不限制。"}
  }
};

function getText(section, key) {
  if (LOCALE_MAP[section] && LOCALE_MAP[section][key]) {
    return LOCALE_MAP[section][key];
  }
  return {
    title: key.replace(/_/g, ' '),
    desc: '暂无说明，请参考配置文档。'
  };
}

function getSectionLabel(section) {
  return (LOCALE_MAP[section] && LOCALE_MAP[section].label) || `${section} 设置`;
}

async function init() {
  apiKey = await ensureApiKey();
  if (apiKey === null) return;
  loadData();
}

async function loadData() {
  try {
    const res = await fetch('/api/v1/admin/config', {
      headers: buildAuthHeaders(apiKey)
    });
    if (res.ok) {
      currentConfig = await res.json();
      renderConfig(currentConfig);
    } else if (res.status === 401) {
      logout();
    }
  } catch (e) {
    showToast('连接失败', 'error');
  }
}

function renderConfig(data) {
  const container = document.getElementById('config-container');
  container.innerHTML = '';

  const sections = Object.keys(data);
  const sectionOrder = Object.keys(LOCALE_MAP);

  sections.sort((a, b) => {
    const ia = sectionOrder.indexOf(a);
    const ib = sectionOrder.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1; // Known sections first
    if (ib !== -1) return 1;
    return 0;
  });

  sections.forEach(section => {
    const items = data[section];

    const card = document.createElement('div');
    card.className = 'config-section';

    const header = document.createElement('div');
    header.innerHTML = `<div class="config-section-title">${getSectionLabel(section)}</div>`;
    card.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'config-grid';

    const keys = Object.keys(items);
    if (LOCALE_MAP[section]) {
      const order = Object.keys(LOCALE_MAP[section]);
      keys.sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return 0;
      });
    }

    keys.forEach(key => {
      const val = items[key];
      const text = getText(section, key);

      // Container
      const fieldCard = document.createElement('div');
      fieldCard.className = 'config-field';

      // Title
      const titleEl = document.createElement('div');
      titleEl.className = 'config-field-title';
      titleEl.textContent = text.title;
      fieldCard.appendChild(titleEl);

      // Description (Muted)
      const descEl = document.createElement('p');
      descEl.className = 'config-field-desc';
      descEl.textContent = text.desc;
      fieldCard.appendChild(descEl);

      // Input Wrapper
      const inputWrapper = document.createElement('div');
      inputWrapper.className = 'config-field-input';

      // Input Logic
      let input;
      if (typeof val === 'boolean') {
        const label = document.createElement('label');
        label.className = 'relative inline-flex items-center cursor-pointer';

        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = val;
        input.className = 'sr-only peer';
        input.dataset.section = section;
        input.dataset.key = key;

        const slider = document.createElement('div');
        slider.className = "w-9 h-5 bg-[var(--accents-2)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-black";

        label.appendChild(input);
        label.appendChild(slider);
        inputWrapper.appendChild(label);
      }
      else if (key === 'image_format') {
        input = document.createElement('select');
        input.className = 'geist-input h-[34px]'; // Matches reduced padding inputs
        input.dataset.section = section;
        input.dataset.key = key;

        const opts = [
          { val: 'url', text: 'URL' },
          { val: 'base64', text: 'Base64' },
          { val: 'b64_json', text: 'b64_json' }
        ];

        opts.forEach(opt => {
          const option = document.createElement('option');
          option.value = opt.val;
          option.text = opt.text;
          if (val === opt.val) option.selected = true;
          input.appendChild(option);
        });
        inputWrapper.appendChild(input);
      }
      else if (key === 'image_generation_method') {
        input = document.createElement('select');
        input.className = 'geist-input h-[34px]';
        input.dataset.section = section;
        input.dataset.key = key;

        const opts = [
          { val: 'legacy', text: '旧方法（默认）' },
          { val: 'imagine_ws_experimental', text: '新方法（实验性）' }
        ];

        opts.forEach(opt => {
          const option = document.createElement('option');
          option.value = opt.val;
          option.text = opt.text;
          if (val === opt.val) option.selected = true;
          input.appendChild(option);
        });
        inputWrapper.appendChild(input);
      }
      else if (key === 'video_format') {
        input = document.createElement('select');
        input.className = 'geist-input h-[34px]';
        input.dataset.section = section;
        input.dataset.key = key;

        const opts = [
          { val: 'html', text: 'HTML' },
          { val: 'url', text: 'URL' }
        ];

        opts.forEach(opt => {
          const option = document.createElement('option');
          option.value = opt.val;
          option.text = opt.text;
          if (val === opt.val) option.selected = true;
          input.appendChild(option);
        });

        inputWrapper.appendChild(input);
      }
      else if (key === 'upscale_timing') {
        input = document.createElement('select');
        input.className = 'geist-input h-[34px]';
        input.dataset.section = section;
        input.dataset.key = key;

        const opts = [
          { val: 'complete', text: '全部完成后超分' },
          { val: 'single', text: '每轮扩展后超分' }
        ];

        opts.forEach(opt => {
          const option = document.createElement('option');
          option.value = opt.val;
          option.text = opt.text;
          if (val === opt.val) option.selected = true;
          input.appendChild(option);
        });
        inputWrapper.appendChild(input);
      }
      else if (key === 'custom_instruction') {
        input = document.createElement('textarea');
        input.className = 'geist-input';
        input.rows = 5;
        input.value = val || '';
        input.dataset.section = section;
        input.dataset.key = key;
        inputWrapper.appendChild(input);
      }
      else if (Array.isArray(val) || typeof val === 'object') {
        input = document.createElement('textarea');
        input.className = 'geist-input font-mono text-xs';
        input.rows = 4;
        input.value = JSON.stringify(val, null, 2);
        input.dataset.section = section;
        input.dataset.key = key;
        input.dataset.type = 'json';
        inputWrapper.appendChild(input);
      }
      else {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'geist-input';
        input.value = val;
        input.dataset.section = section;
        input.dataset.key = key;

        if (key === 'app_key') input.type = 'text';

        if (key === 'api_key' || key === 'app_key') {
          const wrapper = document.createElement('div');
          wrapper.className = 'config-secret-row';

          input.className = 'geist-input';

          const copyBtn = document.createElement('button');
          copyBtn.className = 'config-copy-btn';
          copyBtn.type = 'button';
          copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

          copyBtn.onclick = () => copyToClipboard(input.value, copyBtn);

          wrapper.appendChild(input);
          wrapper.appendChild(copyBtn);
          inputWrapper.appendChild(wrapper);
        } else {
          inputWrapper.appendChild(input);
        }
      }

      fieldCard.appendChild(inputWrapper);
      grid.appendChild(fieldCard);
    });

    card.appendChild(grid);

    if (grid.children.length > 0) {
      container.appendChild(card);
    }
  });
}

async function saveConfig() {
  const btn = document.getElementById('save-btn');
  const originalText = btn.innerText;
  btn.disabled = true;
  btn.innerText = '保存中...';

  try {
    const newConfig = JSON.parse(JSON.stringify(currentConfig));
    const inputs = document.querySelectorAll('input[data-section], textarea[data-section], select[data-section]');

    inputs.forEach(input => {
      const s = input.dataset.section;
      const k = input.dataset.key;
      let val = input.value;

      if (input.type === 'checkbox') {
        val = input.checked;
      } else if (input.dataset.type === 'json') {
        try { val = JSON.parse(val); } catch (e) { throw new Error(`无效的 JSON: ${getText(s, k).title}`); }
      } else if (k === 'admin_username' && val.trim() === '') {
        throw new Error('后台账号不能为空');
      } else if (k === 'app_key' && val.trim() === '') {
        throw new Error('后台密码不能为空');
      } else if (NUMERIC_FIELDS.has(k)) {
        if (val.trim() !== '' && !Number.isNaN(Number(val))) {
          val = Number(val);
        }
      }

      if (!newConfig[s]) newConfig[s] = {};
      newConfig[s][k] = val;
    });

    const res = await fetch('/api/v1/admin/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(apiKey)
      },
      body: JSON.stringify(newConfig)
    });

    if (res.ok) {
      btn.innerText = '成功';
      showToast('配置已保存', 'success');
      setTimeout(() => {
        btn.innerText = originalText;
        btn.style.backgroundColor = '';
      }, 2000);
    } else {
      showToast('保存失败', 'error');
    }
  } catch (e) {
    showToast('错误: ' + e.message, 'error');
  } finally {
    if (btn.innerText === '保存中...') {
      btn.disabled = false;
      btn.innerText = originalText;
    } else {
      btn.disabled = false;
    }
  }
}

async function copyToClipboard(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);

    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    btn.style.backgroundColor = '#10b981';
    btn.style.borderColor = '#10b981';

    setTimeout(() => {
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
      btn.style.backgroundColor = '';
      btn.style.borderColor = '';
    }, 2000);
  } catch (err) {
    console.error('Failed to copy', err);
  }
}

window.onload = init;
