/* -------------------------------------------------------------------------
   1. API INTEGRATION AND JSON PROCESSING
   ------------------------------------------------------------------------- */
const { ipcRenderer } = require('electron');

const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=1200&q=80';
const MEAL_PLANS_KEY = 'easycook_mealplans';
const COOKBOOK_KEY = 'easycook_cookbook';

// Safely read an array from Local Storage.
function readStoredArray(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

// Prevent saved or API text from being inserted as raw HTML.
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[character];
  });
}

// Set an image and fall back to a neutral food image if loading fails.
function setImageSource(image, source, alt) {
  if (!image) return;
  image.alt = alt || '';
  image.onerror = () => {
    if (!image.src.includes(FALLBACK_IMAGE)) image.src = FALLBACK_IMAGE;
  };
  image.src = source || FALLBACK_IMAGE;
}

// Show a short message on the detail page.
function setDetailMessage(message, tone) {
  const element = document.getElementById('detailMessage');
  if (!element) return;
  element.textContent = message || '';
  element.classList.remove('is-error', 'is-success');
  if (tone === 'error') element.classList.add('is-error');
  if (tone === 'success') element.classList.add('is-success');
}

// Convert a lookup response into { meal } or { meal: null }.
function processRecipeDetailData(data) {
  if (!data || !Array.isArray(data.meals) || data.meals.length === 0) {
    return { meal: null };
  }
  return { meal: data.meals[0] };
}

// Fetch one full recipe using its TheMealDB ID.
function fetchRecipeById(id) {
  const url = `https://www.themealdb.com/api/json/v1/1/lookup.php?i=${encodeURIComponent(id)}`;

  return fetch(url)
    .then(response => {
      if (!response.ok) throw new Error('Network response was not ok');
      return response.json();
    })
    .then(data => processRecipeDetailData(data))
    .catch(error => ({ meal: null, error: error.message }));
}

// Fetch a random full recipe from the API.
function fetchRandomRecipeDetail() {
  const url = 'https://www.themealdb.com/api/json/v1/1/random.php';

  return fetch(url)
    .then(response => {
      if (!response.ok) throw new Error('Network response was not ok');
      return response.json();
    })
    .then(data => processRecipeDetailData(data))
    .catch(error => ({ meal: null, error: error.message }));
}

/* -------------------------------------------------------------------------
   2. RECIPE RENDERING
   ------------------------------------------------------------------------- */
// Add or remove the disabled state on the recipe action controls.
// Electron does not support window.prompt, so the meal plan name is typed
// into the inline field beside the button.
function setActionsEnabled(enabled) {
  document.getElementById('addToMealPlannerBtn').disabled = !enabled;
  document.getElementById('detailPlanName').disabled = !enabled;
  document.getElementById('addToCookbookBtn').disabled = !enabled;
}

// Show a loading placeholder while the recipe request is in progress.
function showDetailLoading(message) {
  const container = document.getElementById('recipeDetail');
  container.innerHTML = `
    <div class="loading-state" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <span>${escapeHtml(message || 'Loading recipe…')}</span>
    </div>
  `;
  setActionsEnabled(false);
  setDetailMessage('');
}

// Show an error state without exposing API details.
function showDetailError() {
  const container = document.getElementById('recipeDetail');
  container.innerHTML = `
    <div class="empty-state">
      <span class="empty-state-mark" aria-hidden="true">◇</span>
      <p>We couldn't load the recipe.</p>
      <span>Please check your connection and try again.</span>
    </div>
  `;
  setActionsEnabled(false);
  document.getElementById('recipePageTitle').textContent = 'Recipe Article';
}

// Render the complete recipe: image, name, meta, ingredients and instructions.
function displayRecipeDetail(meal, containerId) {
  const container = document.getElementById(containerId);

  if (!meal) {
    showDetailError();
    return;
  }

  // Collect the 20 possible ingredient slots returned by TheMealDB.
  const ingredients = [];
  for (let i = 1; i <= 20; i += 1) {
    const ingredient = meal[`strIngredient${i}`];
    const measure = meal[`strMeasure${i}`];
    if (ingredient && ingredient.trim()) {
      ingredients.push({ ingredient: ingredient, measure: measure || '' });
    }
  }

  const ingredientItems = ingredients.map(item => `
    <li class="article-ingredient-item">
      <input type="checkbox" aria-label="Mark ${escapeHtml(item.ingredient)} as ready">
      <span>${escapeHtml(item.measure)} ${escapeHtml(item.ingredient)}</span>
    </li>
  `).join('');

  // Split instructions into readable steps where line breaks exist.
  const steps = (meal.strInstructions || '').split(/\r?\n+/).filter(step => step.trim());
  const instructionItems = steps.length > 0
    ? steps.map((step, index) => `
        <div class="instruction-step">
          <span class="step-number">${index + 1}</span>
          <p>${escapeHtml(step.trim())}</p>
        </div>
      `).join('')
    : `<p>${escapeHtml(meal.strInstructions || 'No cooking instructions available.')}</p>`;

  container.innerHTML = `
    <div class="article-layout">
      <div class="article-media">
        <img alt="${escapeHtml(meal.strMeal)}">
      </div>
      <div class="article-info">
        <div class="article-meta-row">
          <span class="article-pill">${escapeHtml(meal.strCategory || 'Category')}</span>
          <span class="article-pill">${escapeHtml(meal.strArea || 'Cuisine')}</span>
        </div>
        <h2 class="article-recipe-title">${escapeHtml(meal.strMeal)}</h2>
        <p class="article-serving-note">Adjust the serving size below to scale every ingredient quantity.</p>

        <div class="article-sections">
          <div class="article-section">
            <h3 class="article-section-title">Ingredients</h3>
            <ul class="article-ingredient-list">${ingredientItems}</ul>
          </div>
          <div class="article-section">
            <h3 class="article-section-title">Cooking Instructions</h3>
            <div class="article-instructions">${instructionItems}</div>
          </div>
        </div>
      </div>
    </div>
  `;

  setImageSource(container.querySelector('.article-media img'), meal.strMealThumb, meal.strMeal);

  // Save the data the calculator and action buttons need later.
  container.dataset.ingredients = JSON.stringify(ingredients);
  container.dataset.meal = JSON.stringify({
    id: meal.idMeal,
    name: meal.strMeal,
    thumb: meal.strMealThumb
  });

  // Keep the current recipe available after a page reload.
  try {
    localStorage.setItem('selectedRecipeId', meal.idMeal);
  } catch (error) {
    // This is a convenience only; rendering continues.
  }

  document.getElementById('recipePageTitle').textContent = meal.strMeal;
  document.title = `EasyCook · ${meal.strMeal}`;

  // Suggest the recipe name as the meal plan name, but let the user edit it.
  document.getElementById('detailPlanName').value = meal.strMeal;

  setActionsEnabled(true);
  setDetailMessage('');
  resetServingCalculator();
}

// Clear the serving calculator when a new recipe is shown.
function resetServingCalculator() {
  document.getElementById('calcMessage').textContent = '';
  document.getElementById('calcMessage').classList.remove('is-error', 'is-success');
  document.getElementById('adjustedIngredients').innerHTML = '';
}

// Load and display a recipe by ID.
function loadRecipeById(id) {
  showDetailLoading('Loading recipe…');
  fetchRecipeById(id).then(result => {
    if (result.meal) {
      displayRecipeDetail(result.meal, 'recipeDetail');
    } else {
      showDetailError();
    }
  });
}

// Load and display a random recipe.
function loadRandomRecipe() {
  showDetailLoading('Finding a delicious recipe…');
  fetchRandomRecipeDetail().then(result => {
    if (result.meal) {
      displayRecipeDetail(result.meal, 'recipeDetail');
    } else {
      showDetailError();
    }
  });
}

/* -------------------------------------------------------------------------
   3. SERVING ADJUSTMENT CALCULATION
   Quantities can be whole numbers, decimals, fractions, mixed numbers and
   ranges. Non-numeric measures such as "to taste" stay unchanged.
   ------------------------------------------------------------------------- */
function parseQuantity(value) {
  const text = String(value).trim();

  // Mixed number, for example "1 1/2".
  if (text.includes(' ')) {
    const parts = text.split(/\s+/);
    return parseFloat(parts[0]) + parseQuantity(parts[1]);
  }

  // Simple fraction, for example "1/2".
  if (text.includes('/')) {
    const parts = text.split('/');
    return Number(parts[0]) / Number(parts[1]);
  }

  return parseFloat(text);
}

// Display common kitchen fractions where possible, otherwise two decimals.
function formatQuantity(value) {
  const rounded = Math.round(value * 100) / 100;
  if (!isFinite(rounded)) return '';
  if (Number.isInteger(rounded)) return String(rounded);

  const commonFractions = [
    [0.25, '1/4'],
    [0.33, '1/3'],
    [0.5, '1/2'],
    [0.67, '2/3'],
    [0.75, '3/4']
  ];

  const whole = Math.floor(rounded);
  const remainder = rounded - whole;
  const match = commonFractions.find(item => Math.abs(remainder - item[0]) < 0.03);

  if (match) return whole > 0 ? `${whole} ${match[1]}` : match[1];
  return rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

// Multiply every number in a measure by the serving ratio.
function adjustMeasure(measure, ratio) {
  if (!measure) return '';

  // Match mixed numbers and fractions first, then decimals and whole numbers.
  const quantityPattern = /(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)/g;

  return measure.replace(quantityPattern, match => formatQuantity(parseQuantity(match) * ratio));
}

// Validate servings and return a list of adjusted ingredient quantities.
function calculateAdjustedIngredients(originalServings, desiredServings, ingredients) {
  if (isNaN(originalServings) || isNaN(desiredServings) || originalServings <= 0 || desiredServings <= 0) {
    return { success: false, message: 'Please enter valid serving numbers greater than zero.' };
  }
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return { success: false, message: 'No ingredient data is available for this recipe.' };
  }

  const ratio = desiredServings / originalServings;
  const adjusted = ingredients.map(item => ({
    ingredient: item.ingredient,
    originalMeasure: item.measure,
    adjustedMeasure: adjustMeasure(item.measure, ratio)
  }));

  return { success: true, ratio: ratio, adjusted: adjusted };
}

// Display the adjusted ingredients with the original measure for comparison.
function displayAdjustedIngredients(adjusted, containerId, messageId) {
  const container = document.getElementById(containerId);
  const messageElement = document.getElementById(messageId);
  container.innerHTML = '';

  if (!Array.isArray(adjusted) || adjusted.length === 0) {
    if (messageElement) messageElement.textContent = 'No adjusted ingredients to display.';
    return;
  }

  adjusted.forEach(item => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="adjusted-value">${escapeHtml(item.adjustedMeasure)} ${escapeHtml(item.ingredient)}</span>
      <span class="adjusted-original">was ${escapeHtml(item.originalMeasure || '—')}</span>
    `;
    container.appendChild(li);
  });
}

/* -------------------------------------------------------------------------
   4. COOKBOOK AND MEAL PLANNER ACTIONS
   ------------------------------------------------------------------------- */
// Save the current recipe to Local Storage, avoiding duplicates.
function saveCurrentRecipeToCookbook() {
  const container = document.getElementById('recipeDetail');
  const mealData = container.dataset.meal;

  if (!mealData) {
    setDetailMessage('Open a recipe before saving it.', 'error');
    return;
  }

  try {
    const meal = JSON.parse(mealData);
    const items = readStoredArray(COOKBOOK_KEY);

    if (items.some(item => item.id === meal.id)) {
      setDetailMessage('This recipe is already in your cookbook.', 'error');
      return;
    }

    items.push({ id: meal.id, name: meal.name, thumb: meal.thumb });
    localStorage.setItem(COOKBOOK_KEY, JSON.stringify(items));
    setDetailMessage('Saved to your cookbook.', 'success');
  } catch (error) {
    setDetailMessage("We couldn't save this recipe. Please try again.", 'error');
  }
}

// Add the current recipe to the meal plan list. The existing Local Storage
// key and JSON file structure are kept so old plans remain readable.
function addCurrentRecipeToMealPlanner() {
  const container = document.getElementById('recipeDetail');
  const mealData = container.dataset.meal;

  if (!mealData) {
    setDetailMessage('Open a recipe before creating a meal plan.', 'error');
    return;
  }

  try {
    const meal = JSON.parse(mealData);
    const nameField = document.getElementById('detailPlanName');
    const name = nameField.value.trim();

    // Input validation with clear feedback and focus.
    if (!name) {
      setDetailMessage('Enter a meal plan name first.', 'error');
      nameField.focus();
      return;
    }

    const plan = {
      id: Date.now().toString(),
      name: name,
      recipe: meal.name
    };

    // Mirror the plan into the existing JSON data file through IPC.
    try {
      const existing = ipcRenderer.sendSync('mealplans:read');
      const filePlans = Array.isArray(existing) ? existing : [];
      filePlans.push(plan);
      ipcRenderer.sendSync('mealplans:write', filePlans);
    } catch (fileError) {
      // The Local Storage copy below is still attempted.
    }

    const plans = readStoredArray(MEAL_PLANS_KEY);
    plans.push(plan);
    localStorage.setItem(MEAL_PLANS_KEY, JSON.stringify(plans));

    // Clear the field so a second click cannot create a duplicate by accident.
    nameField.value = '';
    setDetailMessage('Added to your meal planner.', 'success');
  } catch (error) {
    setDetailMessage("We couldn't add this recipe to your meal planner.", 'error');
  }
}

/* -------------------------------------------------------------------------
   5. EVENT LISTENERS AND PAGE START-UP
   ------------------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  // If a recipe was selected on the Discover page, load it. Otherwise show
  // a random recipe so the details page is never blank.
  const selectedId = localStorage.getItem('selectedRecipeId');
  if (selectedId) {
    loadRecipeById(selectedId);
  } else {
    loadRandomRecipe();
  }

  document.getElementById('loadRandomDetailBtn').addEventListener('click', () => {
    loadRandomRecipe();
  });

  document.getElementById('addToCookbookBtn').addEventListener('click', () => {
    saveCurrentRecipeToCookbook();
  });

  document.getElementById('addToMealPlannerBtn').addEventListener('click', () => {
    addCurrentRecipeToMealPlanner();
  });

  // Serving calculator.
  document.getElementById('calcBtn').addEventListener('click', () => {
    const original = parseFloat(document.getElementById('origServings').value);
    const desired = parseFloat(document.getElementById('desiredServings').value);
    const container = document.getElementById('recipeDetail');
    const messageElement = document.getElementById('calcMessage');

    let ingredients = [];
    if (container.dataset.ingredients) {
      try {
        ingredients = JSON.parse(container.dataset.ingredients);
      } catch (error) {
        ingredients = [];
      }
    }

    const result = calculateAdjustedIngredients(original, desired, ingredients);

    if (!result.success) {
      messageElement.textContent = result.message;
      messageElement.classList.remove('is-success');
      messageElement.classList.add('is-error');
      document.getElementById('adjustedIngredients').innerHTML = '';
      return;
    }

    messageElement.textContent = `Adjusted for ${original} → ${desired} servings (scale × ${result.ratio.toFixed(2)}).`;
    messageElement.classList.remove('is-error');
    messageElement.classList.add('is-success');
    displayAdjustedIngredients(result.adjusted, 'adjustedIngredients', 'calcMessage');
  });
});
