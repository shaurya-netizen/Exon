setTimeout(() => {
    btn.innerHTML = originalText;
    btn.disabled = false;
    btn.style.background = 'linear-gradient(135deg, #9B59B6, #FF4081)';
    // Redirect to new page
    window.location.href = 'strategy-result.html';
}, 2000);
