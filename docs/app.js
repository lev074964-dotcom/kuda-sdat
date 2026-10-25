const finder = document.querySelector("#finder");
const video = document.querySelector("#video");
const preview = document.querySelector("#preview");
const canvas = document.querySelector("#frame");
const cameraButton = document.querySelector("#camera-button");
const fileInput = document.querySelector("#file-input");
const fileMeta = document.querySelector("#file-meta");
const result = document.querySelector("#result");
const samplesRoot = document.querySelector("#samples");
const guidesRoot = document.querySelector("#guides");

const SAMPLE_TITLES = [
  ["cardboard", "Картон"],
  ["glass", "Стекло"],
  ["metal", "Металл"],
  ["paper", "Бумага"],
  ["plastic", "Пластик"],
  ["trash", "Смешанные отходы"],
];

let stream = null;
let previewUrl = null;
let busy = false;
let adviceData = null;
let modelPromise = null;

function setBusy(value) {
  busy = value;
  cameraButton.disabled = value;
  fileInput.disabled = value;
  document.querySelectorAll(".sample").forEach((button) => {
    button.disabled = value;
  });
}

function showMedia() {
  finder.classList.add("has-media");
}

function setMeta(text) {
  fileMeta.hidden = !text;
  fileMeta.textContent = text;
}

function showPreview(blob) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  preview.src = previewUrl;
  preview.alt = "Выбранное фото";
  preview.hidden = false;
  video.hidden = true;
  showMedia();
}

function stopCamera() {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.hidden = true;
  cameraButton.textContent = "Включить камеру";
}

function renderLoading(text) {
  result.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "loading";
  const label = document.createElement("p");
  label.textContent = text;
  const meter = document.createElement("div");
  meter.className = "meter";
  meter.append(document.createElement("span"));
  wrap.append(label, meter);
  result.append(wrap);
}

function renderError(message) {
  result.replaceChildren();
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = message;
  result.append(box);
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function resolveLabel(raw) {
  const text = raw.trim().toLowerCase().replaceAll("_", " ").replaceAll("-", " ").replace(/\s+/g, " ");
  for (const [key, aliases] of Object.entries(adviceData.aliases)) {
    if (text === key || aliases.includes(text)) return key;
  }
  for (const [key, aliases] of Object.entries(adviceData.aliases)) {
    for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
      if (alias.length >= 4 && text.includes(alias)) return key;
    }
  }
  return null;
}

function adviceFor(raw) {
  const key = resolveLabel(raw);
  if (!key) {
    return {
      title: raw || "Неизвестный класс",
      summary: `Модель назвала класс «${raw}». Для него в справочнике нет отдельной инструкции.`,
      bin_name: "Уточните у оператора",
      bin_hint: "Посмотрите памятку своего города по этому названию.",
      color: "#8d877c",
      recyclable: false,
      stamp: "Проверьте правила",
      steps: ["Найдите этот материал в правилах местного оператора."],
      avoid: ["Не кладите в обычный бак батарейки, лампы, лекарства и технику."],
    };
  }
  return adviceData.disposal[key];
}

function addList(title, items, ordered) {
  const block = document.createElement("div");
  const heading = document.createElement("h4");
  heading.textContent = title;
  const list = document.createElement(ordered ? "ol" : "ul");
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    list.append(li);
  });
  block.append(heading, list);
  return block;
}

function renderResult(data) {
  const advice = data.advice;
  result.replaceChildren();
  const ticket = document.createElement("article");
  ticket.className = "ticket";
  ticket.style.setProperty("--bin", advice.color || "#8d877c");
  const top = document.createElement("div");
  top.className = "ticket-top";
  const titles = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = data.levelText;
  const heading = document.createElement("h3");
  heading.textContent = advice.title;
  titles.append(eyebrow, heading);
  const stamp = document.createElement("div");
  stamp.className = advice.recyclable ? "stamp" : "stamp is-mixed";
  stamp.textContent = advice.stamp;
  top.append(titles, stamp);
  const confidence = document.createElement("div");
  confidence.className = "confidence";
  const level = document.createElement("span");
  level.textContent = "Совпадение";
  const value = document.createElement("span");
  value.textContent = percent(data.confidence);
  confidence.append(level, value);
  const meter = document.createElement("div");
  meter.className = "meter";
  const bar = document.createElement("span");
  bar.style.width = percent(data.confidence);
  meter.append(bar);
  const summary = document.createElement("p");
  summary.className = "summary";
  summary.textContent = advice.summary;
  const bin = document.createElement("p");
  bin.className = "bin-line";
  const binName = document.createElement("strong");
  binName.textContent = `${advice.bin_name}. `;
  bin.append(binName, document.createTextNode(advice.bin_hint));
  const lists = document.createElement("div");
  lists.className = "lists";
  lists.append(addList("Перед сдачей", advice.steps || [], true), addList("Не класть", advice.avoid || [], false));
  ticket.append(top, confidence, meter, summary, bin, lists);
  if (data.level === "low") {
    const note = document.createElement("p");
    note.className = "low-note";
    note.textContent = "Уверенность низкая. Снимите один предмет крупнее, на ровном светлом фоне.";
    ticket.append(note);
  }
  const alts = data.alternatives.filter((item) => item.confidence >= 0.05);
  if (alts.length) {
    const line = document.createElement("p");
    line.className = "alts";
    line.textContent = `Ещё похоже на: ${alts.map((item) => `${item.title} ${percent(item.confidence)}`).join(", ")}.`;
    ticket.append(line);
  }
  const disclaimer = document.createElement("p");
  disclaimer.className = "model-label";
  disclaimer.textContent = "Цвет контейнера сверьте с памяткой своего двора.";
  ticket.append(disclaimer);
  result.append(ticket);
}

async function loadModel() {
  if (!modelPromise) {
    modelPromise = tf.loadGraphModel("./model/model.json");
  }
  return modelPromise;
}

async function imageFromBlob(blob) {
  if (window.createImageBitmap) {
    return createImageBitmap(blob, { imageOrientation: "from-image" });
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function coverCanvas(image) {
  const size = 224;
  const board = document.createElement("canvas");
  board.width = size;
  board.height = size;
  const context = board.getContext("2d", { willReadFrequently: true });
  const width = image.width || image.videoWidth;
  const height = image.height || image.videoHeight;
  const scale = Math.max(size / width, size / height);
  const drawnWidth = width * scale;
  const drawnHeight = height * scale;
  context.drawImage(image, (size - drawnWidth) / 2, (size - drawnHeight) / 2, drawnWidth, drawnHeight);
  return board;
}

async function classify(blob) {
  if (busy) return;
  if (blob.size > 8 * 1024 * 1024) {
    renderError("Файл больше 8 МБ. Сожмите фото и попробуйте снова.");
    return;
  }
  setBusy(true);
  renderLoading("Скачиваем модель и смотрим на материал…");
  try {
    const model = await loadModel();
    const image = await imageFromBlob(blob);
    const board = coverCanvas(image);
    const probabilities = tf.tidy(() => {
      const pixels = tf.browser.fromPixels(board).toFloat().div(127.5).sub(1).expandDims(0);
      const output = model.execute({ image: pixels });
      return output.dataSync();
    });
    const ranked = [...probabilities]
      .map((confidence, index) => ({ label: adviceData.labels[index], confidence }))
      .sort((a, b) => b.confidence - a.confidence);
    const best = ranked[0];
    const level = best.confidence >= 0.72 ? "high" : best.confidence >= 0.45 ? "medium" : "low";
    const levelText = level === "high" ? "Уверенно" : level === "medium" ? "Есть сомнение" : "Низкая уверенность";
    renderResult({
      confidence: best.confidence,
      level,
      levelText,
      advice: adviceFor(best.label),
      alternatives: ranked.slice(1, 3).map((item) => ({ title: adviceFor(item.label).title, confidence: item.confidence })),
    });
  } catch (error) {
    renderError(error.message || "Не удалось распознать фото.");
  } finally {
    setBusy(false);
  }
}

async function useFile(file) {
  if (!file || busy) return;
  if (file.type && !file.type.startsWith("image/")) {
    renderError("Нужен файл с фото: JPEG, PNG или WebP.");
    return;
  }
  stopCamera();
  showPreview(file);
  const size = file.size > 1024 * 1024
    ? `${(file.size / (1024 * 1024)).toFixed(1)} МБ`
    : `${Math.max(1, Math.round(file.size / 1024))} КБ`;
  setMeta(`${file.name} · ${size}`);
  await classify(file);
}

function drawGuides() {
  adviceData.guideOrder.forEach((key) => {
    const card = adviceData.disposal[key];
    const article = document.createElement("article");
    article.className = "guide-card";
    article.style.setProperty("--bin", card.color);
    const swatch = document.createElement("div");
    swatch.className = "swatch";
    const title = document.createElement("h3");
    title.textContent = card.title;
    const short = document.createElement("p");
    short.className = "short";
    short.textContent = card.short;
    const summary = document.createElement("p");
    summary.textContent = card.summary;
    const bin = document.createElement("p");
    bin.className = "bin-line";
    const strong = document.createElement("strong");
    strong.textContent = `${card.bin_name}. `;
    bin.append(strong, document.createTextNode(card.bin_hint));
    article.append(swatch, title, short, summary, bin);
    guidesRoot.append(article);
  });
  SAMPLE_TITLES.forEach(([id, title]) => {
    const button = document.createElement("button");
    button.className = "sample";
    button.type = "button";
    const img = document.createElement("img");
    img.src = `samples/${id}.jpg`;
    img.alt = `Пример: ${title}`;
    const span = document.createElement("span");
    span.textContent = title;
    button.append(img, span);
    button.addEventListener("click", async () => {
      if (busy) return;
      const response = await fetch(img.src);
      const blob = await response.blob();
      stopCamera();
      showPreview(blob);
      setMeta(`Пример · ${title}`);
      await classify(blob);
    });
    samplesRoot.append(button);
  });
}

cameraButton.addEventListener("click", async () => {
  if (busy) return;
  if (stream) {
    if (!video.videoWidth) {
      renderError("Камера ещё не дала кадр. Подождите секунду и снимите снова.");
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const shot = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!shot) {
      renderError("Не удалось сохранить кадр. Попробуйте ещё раз.");
      return;
    }
    stopCamera();
    showPreview(shot);
    setMeta("Снимок с камеры");
    await classify(shot);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    renderError("Этот браузер не открывает камеру. Загрузите фото файлом.");
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    video.srcObject = stream;
    video.hidden = false;
    preview.hidden = true;
    showMedia();
    setMeta("Камера включена. Наведите на один предмет и нажмите «Снять».");
    cameraButton.textContent = "Снять";
    await video.play();
  } catch {
    stopCamera();
    renderError("Камера недоступна. Разрешите доступ или загрузите готовое фото.");
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  useFile(file);
});

["dragenter", "dragover"].forEach((name) => {
  finder.addEventListener(name, (event) => {
    event.preventDefault();
    finder.classList.add("is-drag");
  });
});
["dragleave", "drop"].forEach((name) => {
  finder.addEventListener(name, (event) => {
    event.preventDefault();
    finder.classList.remove("is-drag");
  });
});
finder.addEventListener("drop", (event) => useFile(event.dataTransfer?.files?.[0]));
window.addEventListener("pagehide", stopCamera);

adviceData = await fetch("advice.json").then((response) => response.json());
drawGuides();
loadModel().catch(() => {});
