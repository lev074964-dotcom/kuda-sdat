const finder = document.querySelector("#finder");
const finderEmpty = document.querySelector("#finder-empty");
const video = document.querySelector("#video");
const preview = document.querySelector("#preview");
const canvas = document.querySelector("#frame");
const cameraButton = document.querySelector("#camera-button");
const fileInput = document.querySelector("#file-input");
const fileMeta = document.querySelector("#file-meta");
const result = document.querySelector("#result");
let stream = null;
let previewUrl = null;
let busy = false;

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
  finderEmpty.hidden = true;
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

function renderLoading() {
  result.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "loading";
  const text = document.createElement("p");
  text.textContent = "Смотрим на материал…";
  const meter = document.createElement("div");
  meter.className = "meter";
  meter.append(document.createElement("span"));
  wrap.append(text, meter);
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
  eyebrow.textContent = data.level_text;
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
  lists.append(
    addList("Перед сдачей", advice.steps || [], true),
    addList("Не класть", advice.avoid || [], false),
  );

  ticket.append(top, confidence, meter, summary, bin, lists);

  if (data.level === "low") {
    const note = document.createElement("p");
    note.className = "low-note";
    note.textContent = "Уверенность низкая. Снимите один предмет крупнее, на ровном светлом фоне, без пакета и чужих вещей в кадре.";
    ticket.append(note);
  } else if (data.level === "medium" && data.alternatives?.length) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Есть соседний вариант. Если предмет смешанный или грязный, ориентируйтесь на более осторожный бак.";
    ticket.append(note);
  }

  const alts = (data.alternatives || []).filter((item) => item.confidence >= 0.05);
  if (alts.length) {
    const line = document.createElement("p");
    line.className = "alts";
    line.textContent = `Ещё похоже на: ${alts
      .map((item) => `${item.title} ${percent(item.confidence)}`)
      .join(", ")}.`;
    ticket.append(line);
  }

  const modelLabel = document.createElement("p");
  modelLabel.className = "model-label";
  modelLabel.textContent = `Класс модели: ${data.label}`;
  ticket.append(modelLabel);

  const disclaimer = document.createElement("p");
  disclaimer.className = "model-label";
  disclaimer.textContent = "Цвет контейнера сверьте с памяткой своего двора.";
  ticket.append(disclaimer);

  result.append(ticket);
}

async function classify(blob, filename) {
  if (busy) return;
  if (blob.size > 8 * 1024 * 1024) {
    renderError("Файл больше 8 МБ. Сожмите фото и попробуйте снова.");
    return;
  }
  setBusy(true);
  renderLoading();
  const body = new FormData();
  body.append("file", blob, filename || "photo.jpg");
  try {
    const response = await fetch("/api/classify", { method: "POST", body });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof payload.detail === "string" ? payload.detail : "Не удалось распознать фото.";
      throw new Error(detail);
    }
    renderResult(payload);
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
  await classify(file, file.name);
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
    await classify(shot, "camera.jpg");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    renderError("Этот браузер не открывает камеру. Загрузите фото файлом.");
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    video.srcObject = stream;
    video.hidden = false;
    preview.hidden = true;
    showMedia();
    setMeta("Камера включена. Наведите на один предмет и нажмите «Снять».");
    cameraButton.textContent = "Снять";
    await video.play();
  } catch (error) {
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

finder.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  useFile(file);
});

document.querySelectorAll(".sample").forEach((button) => {
  button.addEventListener("click", async () => {
    if (busy) return;
    try {
      const response = await fetch(button.dataset.src);
      if (!response.ok) throw new Error("Пример не открылся.");
      const blob = await response.blob();
      stopCamera();
      showPreview(blob);
      setMeta(`Пример · ${button.querySelector("span").textContent}`);
      await classify(blob, button.dataset.name || "sample.jpg");
    } catch (error) {
      renderError(error.message || "Пример не открылся.");
    }
  });
});

window.addEventListener("pagehide", stopCamera);
