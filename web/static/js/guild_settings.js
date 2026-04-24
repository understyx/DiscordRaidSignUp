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
