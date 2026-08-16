function toggleRolePicker() {
  const roleSelected = document.getElementById('srRole') && document.getElementById('srRole').checked;
  const picker = document.getElementById('rolePickerGroup');
  if (!picker) return;
  if (roleSelected) {
    picker.classList.remove('d-none');
  } else {
    picker.classList.add('d-none');
  }
}

function normalizeEmbedColor(value) {
  const match = String(value || '')
    .trim()
    .match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const hex = match[1];
  const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
  return `#${expanded.toUpperCase()}`;
}

function initCustomEmbedPreview() {
  const preview = document.getElementById('linkEmbedPreview');
  if (!preview) return;

  const titleInput = document.getElementById('embedTitle');
  const descriptionInput = document.getElementById('embedDescription');
  const imageInput = document.getElementById('embedImageUrl');
  const colorInput = document.getElementById('embedColor');
  const colorPicker = document.getElementById('embedColorPicker');
  const previewTitle = document.getElementById('linkEmbedPreviewTitle');
  const previewDescription = document.getElementById('linkEmbedPreviewDescription');
  const previewImage = document.getElementById('linkEmbedPreviewImage');
  let imageTimer = null;

  function updateTextAndColor() {
    previewTitle.textContent = titleInput.value.trim() || preview.dataset.defaultTitle;
    previewDescription.textContent =
      descriptionInput.value.trim() || preview.dataset.defaultDescription;

    const color = normalizeEmbedColor(colorInput.value);
    preview.style.setProperty('--link-embed-color', color || '#5865F2');
    if (color) colorPicker.value = color;
  }

  function updateImage() {
    const url = imageInput.value.trim();
    if (!url) {
      previewImage.removeAttribute('src');
      previewImage.classList.add('d-none');
      return;
    }
    previewImage.classList.add('d-none');
    previewImage.src = url;
  }

  titleInput.addEventListener('input', updateTextAndColor);
  descriptionInput.addEventListener('input', updateTextAndColor);
  colorInput.addEventListener('input', updateTextAndColor);
  colorPicker.addEventListener('input', () => {
    colorInput.value = colorPicker.value.toUpperCase();
    updateTextAndColor();
  });
  imageInput.addEventListener('input', () => {
    window.clearTimeout(imageTimer);
    imageTimer = window.setTimeout(updateImage, 250);
  });
  previewImage.addEventListener('load', () => previewImage.classList.remove('d-none'));
  previewImage.addEventListener('error', () => previewImage.classList.add('d-none'));

  updateTextAndColor();
  updateImage();
}

document.addEventListener('DOMContentLoaded', initCustomEmbedPreview);
