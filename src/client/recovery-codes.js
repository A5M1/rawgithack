const codesEl = document.getElementById('recovery-codes');
const copyButton = document.getElementById('copy-codes');
const downloadButton = document.getElementById('download-codes');

const codesText = () => codesEl.textContent.trim();

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(codesText());
    copyButton.textContent = 'copied!';
    setTimeout(() => { copyButton.textContent = 'copy all codes'; }, 1200);
  } catch {
    codesEl.focus();
  }
});

downloadButton.addEventListener('click', () => {
  const blob = new Blob([codesText() + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'recovery-codes.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
