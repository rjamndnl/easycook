/* =========================================================================
   EasyCook - shared visual decoration
   Adds a subtle fade-in to recipe-related cards, including cards that are
   created later by JavaScript. No recipe logic lives in this file.
   ========================================================================= */
document.addEventListener('DOMContentLoaded', function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) return;

  const cardSelector = '.recipe-card, .suggestion-card, .cookbook-card, .mealplan-card';
  let staggerIndex = 0;

  // Mark one card as animated. The delay is capped so large lists stay calm.
  function decorateCard(card) {
    if (!card || card.classList.contains('fade-in-up')) return;
    card.style.animationDelay = `${Math.min(staggerIndex * 35, 220)}ms`;
    card.classList.add('fade-in-up');
    staggerIndex += 1;
  }

  // Decorate cards inside an element (including the element itself).
  function decorateCards(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches(cardSelector)) decorateCard(root);
    root.querySelectorAll(cardSelector).forEach(decorateCard);
  }

  decorateCards(document.body);

  // Watch for cards added by search, filters or Local Storage rendering.
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === 1) decorateCards(node);
      });
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
});
