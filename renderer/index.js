/* 
   1. LOCAL STORAGE KEYS AND HELPERS
   Existing keys are kept so previously saved meal plans and cookbook
   entries continue to load after this update.
    */
const { ipcRenderer } = require('electron');

const STORAGE_KEYS = {
  mealPlans: 'easycook_mealplans',
  suggestions: 'easycook_suggestions',
  cookbook: 'easycook_cookbook',
  featuredLast: 'easycook_featured_last',
  selectedRecipe: 'selectedRecipeId'
};

const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=800&q=80';

// Read JSON safely. A broken or missing value returns the fallback instead
// of stopping the whole application.
function readStoredJson(key, fallbackValue) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallbackValue;
    return JSON.parse(raw);
  } catch (error) {
    return fallbackValue;
  }
}

// Write JSON safely and report whether it worked.
function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    return false;
  }
}

/* 
   2. MEAL PLAN MODEL AND MANAGER (OOP)
   MealPlan stores one record. MealPlanManager owns all CRUD operations.
    */
class MealPlan {
  constructor(id, name, recipe) {
    this.id = id;
    this.name = name;
    this.recipe = recipe;
  }
}

class MealPlanManager {
  constructor() {
    // The old key is reused so existing saved data remains readable.
    this.storageKey = STORAGE_KEYS.mealPlans;
  }

  // READ: load all meal plans from Local Storage.
  getAll() {
    try {
      const data = localStorage.getItem(this.storageKey);
      if (data) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && Array.isArray(parsed.mealPlans)) return parsed.mealPlans;
      }

      // First-run fallback: ask the main process for the JSON mirror.
      // ipcRenderer keeps filesystem access out of the renderer.
      try {
        const filePlans = ipcRenderer.sendSync('mealplans:read');
        if (Array.isArray(filePlans)) return filePlans;
      } catch (fileError) {
        // The JSON file is an optional mirror; Local Storage still works.
      }
      return [];
    } catch (error) {
      return [];
    }
  }

  // WRITE: save all plans to Local Storage and mirror them to the JSON file.
  saveAll(plans) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(plans));

      // Mirror the list to the JSON file through the main process.
      try {
        ipcRenderer.sendSync('mealplans:write', plans);
      } catch (fileError) {
        // Keep the Local Storage copy even if the file cannot be written.
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  // CREATE: add a new meal plan after validation.
  create(plan) {
    if (!plan.name || !plan.recipe) {
      return { success: false, message: 'Please provide a plan name and recipe.' };
    }
    const plans = this.getAll();
    plans.push(plan);
    if (this.saveAll(plans)) {
      return { success: true, message: 'Meal plan saved.' };
    }
    return { success: false, message: "We couldn't save the meal plan. Please try again." };
  }

  // UPDATE: change an existing plan found by its ID.
  update(plan) {
    if (!plan.id) {
      return { success: false, message: 'Please provide a meal plan ID to update.' };
    }
    const plans = this.getAll();
    const index = plans.findIndex(item => String(item.id) === String(plan.id));
    if (index === -1) {
      return { success: false, message: 'Meal plan not found.' };
    }
    if (plan.name) plans[index].name = plan.name;
    if (plan.recipe) plans[index].recipe = plan.recipe;
    if (this.saveAll(plans)) {
      return { success: true, message: 'Meal plan updated.' };
    }
    return { success: false, message: "We couldn't update the meal plan. Please try again." };
  }

  // DELETE: remove the plan with the matching ID.
  delete(id) {
    const plans = this.getAll();
    const filtered = plans.filter(item => String(item.id) !== String(id));
    if (filtered.length === plans.length) {
      return { success: false, message: 'Meal plan not found.' };
    }
    if (this.saveAll(filtered)) {
      return { success: true, message: 'Meal plan removed.' };
    }
    return { success: false, message: "We couldn't remove the meal plan. Please try again." };
  }
}

const mealPlanManager = new MealPlanManager();

/* 
   3. THEMEALDB API INTEGRATION
   Every request returns a small result object: { meals/meal, error }.
   Raw API responses and URLs are never shown in the interface.
    */
const searchCache = new Map();
const categoryCache = new Map();
const detailCache = new Map();

// Convert a search response into a predictable result shape.
function processRecipeSearchData(data) {
  if (!data || !Array.isArray(data.meals)) {
    return { meals: null };
  }
  return { meals: data.meals };
}

// Convert a lookup response (one recipe) into a predictable result shape.
function processRecipeDetailData(data) {
  if (!data || !Array.isArray(data.meals) || data.meals.length === 0) {
    return { meal: null };
  }
  return { meal: data.meals[0] };
}

// Search recipes by name. Successful searches are cached for this session.
function fetchRecipesByName(name) {
  const query = name.trim();
  const cacheKey = query.toLowerCase();

  if (searchCache.has(cacheKey)) {
    return Promise.resolve(searchCache.get(cacheKey));
  }

  const url = `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(query)}`;

  return fetch(url)
    .then(response => {
      if (!response.ok) throw new Error('Network response was not ok');
      return response.json();
    })
    .then(data => {
      const result = processRecipeSearchData(data);
      if (result.meals) searchCache.set(cacheKey, result);
      return result;
    })
    .catch(error => ({ meals: null, error: error.message }));
}

// Load one random recipe from the API.
function fetchRandomRecipe() {
  const url = 'https://www.themealdb.com/api/json/v1/1/random.php';

  return fetch(url)
    .then(response => {
      if (!response.ok) throw new Error('Network response was not ok');
      return response.json();
    })
    .then(data => processRecipeSearchData(data))
    .catch(error => ({ meals: null, error: error.message }));
}

// Filter recipes by category. These results only contain the summary fields,
// so the recipe modal loads full details by ID when needed.
function fetchRecipesByCategory(category) {
  if (categoryCache.has(category)) {
    return Promise.resolve(categoryCache.get(category));
  }

  const url = `https://www.themealdb.com/api/json/v1/1/filter.php?c=${encodeURIComponent(category)}`;

  return fetch(url)
    .then(response => {
      if (!response.ok) throw new Error('Network response was not ok');
      return response.json();
    })
    .then(data => {
      const result = processRecipeSearchData(data);
      if (result.meals) categoryCache.set(category, result);
      return result;
    })
    .catch(error => ({ meals: null, error: error.message }));
}

// Load a full recipe by its API ID. Used when a list only has summary data.
function fetchRecipeById(id) {
  if (detailCache.has(id)) {
    return Promise.resolve(detailCache.get(id));
  }

  const url = `https://www.themealdb.com/api/json/v1/1/lookup.php?i=${encodeURIComponent(id)}`;

  return fetch(url)
    .then(response => {
      if (!response.ok) throw new Error('Network response was not ok');
      return response.json();
    })
    .then(data => {
      const result = processRecipeDetailData(data);
      if (result.meal) detailCache.set(id, result);
      return result;
    })
    .catch(error => ({ meal: null, error: error.message }));
}

/* 
   4. SHARED UI HELPERS
   These keep status messages, loading states and empty states consistent.
    */
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[character];
  });
}

// Show a short message in an existing status element.
function setStatus(elementId, message, tone) {
  const element = document.getElementById(elementId);
  if (!element) return;
  element.textContent = message || '';
  element.classList.remove('is-error', 'is-success');
  if (tone === 'error') element.classList.add('is-error');
  if (tone === 'success') element.classList.add('is-success');
}

// Insert a spinner-style loading state inside a container.
function showLoadingState(containerId, message) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <div class="loading-state" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <span>${escapeHtml(message || 'Loading…')}</span>
    </div>
  `;
}

// Insert a consistent empty state inside a container.
function showEmptyState(containerId, message, hint) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <div class="empty-state">
      <span class="empty-state-mark" aria-hidden="true">◇</span>
      <p>${escapeHtml(message || 'Nothing to show yet.')}</p>
      ${hint ? `<span>${escapeHtml(hint)}</span>` : ''}
    </div>
  `;
}

// Set an image source and use a neutral fallback if the image fails.
function setImageSource(image, source, alt) {
  if (!image) return;
  image.alt = alt || '';
  image.onerror = () => {
    if (!image.src.includes(FALLBACK_IMAGE)) image.src = FALLBACK_IMAGE;
  };
  image.src = source || FALLBACK_IMAGE;
}

// Build a category • area line from whatever the API returned.
function buildMeta(meal) {
  if (!meal) return '';
  const parts = [];
  if (meal.strCategory) parts.push(meal.strCategory);
  if (meal.strArea) parts.push(meal.strArea);
  return parts.length ? parts.join(' · ') : 'Recipe details';
}

// Switch between the Discover and Meal Plans views.
function showView(viewName) {
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  document.querySelectorAll('.nav-btn[data-view]').forEach(button => button.classList.remove('active'));

  const targetView = document.getElementById(`view-${viewName}`);
  const targetButton = document.querySelector(`.nav-btn[data-view="${viewName}"]`);

  if (targetView) targetView.classList.add('active');
  if (targetButton) targetButton.classList.add('active');
}

/* 
   5. RECIPE MODAL AND COOKBOOK
   The modal is the quick "Recipe Details" view used from recipe cards.
    */
let activeModalMeal = null;
let activeModalRequestId = null;

// Fill every field in the modal from one meal object so the image,
// title and information always belong to the same recipe.
function renderModalContent(meal) {
  document.getElementById('modalTitle').textContent = meal.strMeal || 'Recipe Details';

  const image = document.getElementById('modalImg');
  setImageSource(image, meal.strMealThumb, meal.strMeal || 'Recipe image');
  document.getElementById('modalMeta').textContent = buildMeta(meal);

  const ingredientList = document.getElementById('modalIngredients');
  ingredientList.innerHTML = '';
  let ingredientCount = 0;

  for (let i = 1; i <= 20; i += 1) {
    const ingredient = meal[`strIngredient${i}`];
    const measure = meal[`strMeasure${i}`];
    if (ingredient && ingredient.trim()) {
      const item = document.createElement('li');
      item.textContent = `${measure || ''} ${ingredient}`.trim();
      ingredientList.appendChild(item);
      ingredientCount += 1;
    }
  }

  if (ingredientCount === 0) {
    const item = document.createElement('li');
    item.className = 'modal-empty';
    item.textContent = 'No ingredient list available.';
    ingredientList.appendChild(item);
  }

  document.getElementById('modalInstructions').textContent =
    meal.strInstructions || 'No cooking instructions available.';

  document.getElementById('modalCookbookBtn').disabled = false;
  document.getElementById('modalFullRecipeBtn').disabled = false;
}

// Show a loading message while a summary result is upgraded to full details.
function setModalLoading(meal) {
  document.getElementById('modalTitle').textContent = meal.strMeal || 'Recipe Details';
  const image = document.getElementById('modalImg');
  setImageSource(image, meal.strMealThumb, meal.strMeal || 'Recipe image');
  document.getElementById('modalMeta').textContent = 'Loading recipe details…';
  document.getElementById('modalIngredients').innerHTML =
    '<li class="modal-empty">Loading ingredients…</li>';
  document.getElementById('modalInstructions').textContent = 'Loading instructions…';
  document.getElementById('modalCookbookBtn').disabled = true;
  document.getElementById('modalFullRecipeBtn').disabled = true;
}

// Open the quick-view modal. Category results only contain summary fields,
// so a lookup request is made before showing ingredients and instructions.
function openRecipeModal(meal) {
  if (!meal || !meal.idMeal) return;

  activeModalMeal = meal;
  activeModalRequestId = meal.idMeal;
  setStatus('modalStatus', '');

  const modal = document.getElementById('recipeModal');
  modal.classList.add('active');
  document.body.classList.add('modal-open');

  const needsFullDetails = !meal.strInstructions && !meal.strIngredient1;

  if (!needsFullDetails) {
    renderModalContent(meal);
    return;
  }

  setModalLoading(meal);

  fetchRecipeById(meal.idMeal).then(result => {
    // Ignore an old response if the user already opened another recipe.
    if (activeModalRequestId !== meal.idMeal) return;
    if (result.meal) {
      activeModalMeal = result.meal;
      renderModalContent(result.meal);
    } else {
      document.getElementById('modalMeta').textContent = "We couldn't load the full recipe.";
      document.getElementById('modalIngredients').innerHTML =
        '<li class="modal-empty">Please try again later.</li>';
      document.getElementById('modalInstructions').textContent = '';
    }
  });
}

function closeRecipeModal() {
  document.getElementById('recipeModal').classList.remove('active');
  document.body.classList.remove('modal-open');
  activeModalRequestId = null;
}

// READ: cookbook entries from Local Storage.
function getCookbook() {
  const items = readStoredJson(STORAGE_KEYS.cookbook, []);
  return Array.isArray(items) ? items : [];
}

// WRITE: cookbook entries to Local Storage.
function saveCookbook(items) {
  return writeStoredJson(STORAGE_KEYS.cookbook, items);
}

// CREATE: add a recipe to the cookbook, avoiding duplicates.
function addToCookbook(meal) {
  if (!meal || !meal.idMeal || !meal.strMeal) {
    return { success: false, message: 'Recipe details are not ready yet.' };
  }

  const items = getCookbook();
  if (items.some(item => item.id === meal.idMeal)) {
    setStatus('cookbookMessage', 'This recipe is already in your cookbook.');
    return { success: false, message: 'Already in your cookbook.' };
  }

  items.push({
    id: meal.idMeal,
    name: meal.strMeal,
    thumb: meal.strMealThumb || ''
  });

  if (!saveCookbook(items)) {
    return { success: false, message: "We couldn't save this recipe." };
  }

  setStatus('cookbookMessage', 'Saved to your cookbook.', 'success');
  renderCookbook();
  return { success: true, message: 'Saved to your cookbook.' };
}

// Open the full details page for a saved recipe.
function openRecipePage(id) {
  localStorage.setItem(STORAGE_KEYS.selectedRecipe, id);
  window.location.href = 'recipe.html';
}

// DELETE and render the cookbook list.
function renderCookbook() {
  const list = document.getElementById('cookbookList');
  if (!list) return;

  list.innerHTML = '';
  const items = getCookbook();

  if (items.length === 0) {
    showEmptyState(
      'cookbookList',
      'Your cookbook is empty.',
      'Open a recipe and choose “Save to Cookbook” to keep it here.'
    );
    return;
  }

  items.forEach(item => {
    const card = document.createElement('article');
    card.className = 'cookbook-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${item.name}`);
    card.innerHTML = `
      <div class="cookbook-card-media">
        <img alt="${escapeHtml(item.name)}" loading="lazy">
      </div>
      <div class="cookbook-card-body">
        <h3>${escapeHtml(item.name)}</h3>
        <div class="cookbook-card-actions">
          <button class="btn btn-accent btn-xs cookbook-open" type="button">Open</button>
          <button class="btn btn-danger btn-xs cookbook-remove" type="button">Remove</button>
        </div>
      </div>
    `;

    setImageSource(card.querySelector('img'), item.thumb, item.name);

    const open = () => openRecipePage(item.id);
    card.querySelector('.cookbook-open').addEventListener('click', event => {
      event.stopPropagation();
      open();
    });
    card.addEventListener('click', open);
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });

    card.querySelector('.cookbook-remove').addEventListener('click', event => {
      event.stopPropagation();
      const updated = getCookbook().filter(saved => saved.id !== item.id);
      if (saveCookbook(updated)) {
        setStatus('cookbookMessage', 'Recipe removed from your cookbook.', 'success');
        renderCookbook();
      } else {
        setStatus('cookbookMessage', "We couldn't remove this recipe.", 'error');
      }
    });

    list.appendChild(card);
  });
}

/* 
   6. RECIPE SUGGESTIONS (STUDENT-WRITTEN LOGIC)
   if/else decides which API action to call for each category. Successful
   suggestions are stored in Local Storage and reused if a request fails.
    */
function getStoredSuggestions() {
  const saved = readStoredJson(STORAGE_KEYS.suggestions, null);
  return saved && Array.isArray(saved.meals) ? saved : null;
}

function saveSuggestions(category, meals) {
  if (!Array.isArray(meals) || meals.length === 0) return false;
  return writeStoredJson(STORAGE_KEYS.suggestions, {
    category: category || 'All',
    meals: meals,
    savedAt: new Date().toISOString()
  });
}

function getSavedSuggestionsFor(category) {
  const saved = getStoredSuggestions();
  if (!saved) return null;
  if (!category || category === 'All' || saved.category === category) {
    return saved.meals;
  }
  return null;
}

function getRecipeSuggestionsByCategory(category) {
  // Choice 1: All recipes use a broad chicken search.
  if (!category || category === 'All') {
    return fetchRecipesByName('chicken').then(result => {
      if (result.error || !result.meals || result.meals.length === 0) {
        const saved = getSavedSuggestionsFor(category);
        if (saved) return { success: true, meals: saved, fromCache: true };
        return { success: false, message: "We couldn't load suggestions." };
      }
      const meals = result.meals.slice(0, 4);
      saveSuggestions(category, meals);
      return { success: true, meals: meals };
    });
  }

  // Choice 2: A named category uses the matching API filter (or grouped filters).
  return fetchRecipesForCategory(category).then(result => {
    if (result.error || !result.meals || result.meals.length === 0) {
      const saved = getSavedSuggestionsFor(category);
      if (saved) return { success: true, meals: saved, fromCache: true };
      return { success: false, message: 'No recipes found for this category.' };
    }
    const meals = result.meals.slice(0, 4);
    saveSuggestions(category, meals);
    return { success: true, meals: meals };
  });
}

// Render suggestion cards from API or saved Local Storage data.
function displaySuggestions(result, category) {
  const container = document.getElementById('suggestionResult');
  if (!container) return;

  container.innerHTML = '';
  setStatus('suggestionStatus', '');

  if (!result.success) {
    showEmptyState('suggestionResult', result.message, 'Check your connection and try again.');
    return;
  }

  if (result.fromCache) {
    setStatus('suggestionStatus', 'Showing your saved suggestions.', 'success');
  }

  result.meals.forEach(meal => {
    const card = document.createElement('article');
    card.className = 'suggestion-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `View ${meal.strMeal}`);
    card.innerHTML = `
      <div class="suggestion-image">
        <img alt="${escapeHtml(meal.strMeal)}" loading="lazy">
      </div>
      <div class="suggestion-info">
        <h4>${escapeHtml(meal.strMeal)}</h4>
        <p>${escapeHtml(meal.strCategory || category || 'Suggestion')}</p>
        <button class="btn btn-secondary btn-xs suggestion-view" type="button">View</button>
      </div>
    `;

    setImageSource(card.querySelector('img'), meal.strMealThumb, meal.strMeal);

    const open = () => openRecipeModal(meal);
    card.querySelector('.suggestion-view').addEventListener('click', event => {
      event.stopPropagation();
      open();
    });
    card.addEventListener('click', open);
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });

    container.appendChild(card);
  });
}

/* 
   7. FEATURED RECIPE
   A small pool of real recipes is loaded once. The featured recipe changes
   on launch and when "Next Recipe" is clicked, never on a timer.
    */
const FEATURED_SEARCHES = ['chicken', 'pasta', 'cake'];
let featuredPool = [];
let featuredMeal = null;
let featuredLoading = false;

function getLastFeaturedId() {
  try {
    return localStorage.getItem(STORAGE_KEYS.featuredLast) || '';
  } catch (error) {
    return '';
  }
}

function rememberFeatured(id) {
  try {
    localStorage.setItem(STORAGE_KEYS.featuredLast, id);
  } catch (error) {
    // Remembering the ID is optional; the featured card still works.
  }
}

function isSuitableFeatured(meal) {
  return Boolean(meal && meal.idMeal && meal.strMeal && meal.strMealThumb);
}

// Gather real recipes from three existing search requests and remove duplicates.
function loadFeaturedPool() {
  return Promise.all(FEATURED_SEARCHES.map(term => fetchRecipesByName(term))).then(results => {
    const recipesById = new Map();

    results.forEach(result => {
      if (result.error || !Array.isArray(result.meals)) return;
      result.meals.forEach(meal => {
        if (isSuitableFeatured(meal) && !recipesById.has(meal.idMeal)) {
          recipesById.set(meal.idMeal, meal);
        }
      });
    });

    return Array.from(recipesById.values());
  });
}

// Pick a random recipe that is not the one currently on screen.
function pickFeaturedCandidate(excludeId) {
  const options = featuredPool.filter(meal => meal.idMeal !== excludeId);
  const pool = options.length ? options : featuredPool;
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function renderFeatured(meal) {
  featuredMeal = meal;
  const card = document.getElementById('featuredCard');
  const image = document.getElementById('featuredImg');
  const title = document.getElementById('featuredTitle');
  const meta = document.getElementById('featuredMeta');
  const viewButton = document.getElementById('featuredViewBtn');

  card.classList.remove('is-empty', 'is-loading');
  setImageSource(image, meal.strMealThumb, meal.strMeal);
  title.textContent = meal.strMeal;
  meta.textContent = buildMeta(meal);
  viewButton.disabled = false;
  rememberFeatured(meal.idMeal);
}

function showFeaturedError() {
  const card = document.getElementById('featuredCard');
  const image = document.getElementById('featuredImg');
  const viewButton = document.getElementById('featuredViewBtn');

  featuredMeal = null;
  card.classList.add('is-empty');
  card.classList.remove('is-loading');
  image.removeAttribute('src');
  image.alt = '';
  document.getElementById('featuredTitle').textContent = 'Featured recipe unavailable';
  document.getElementById('featuredMeta').textContent = 'Please check your connection and try again.';
  viewButton.disabled = true;
}

function setFeaturedLoading(isLoading) {
  featuredLoading = isLoading;
  const card = document.getElementById('featuredCard');
  const refreshButton = document.getElementById('featuredRefreshBtn');

  if (card) card.classList.toggle('is-loading', isLoading);
  if (refreshButton) refreshButton.disabled = isLoading;
}

// Main featured loader. forceNew is true when the user clicks "Next Recipe".
function loadFeaturedRecipe(forceNew) {
  if (featuredLoading) return;

  setFeaturedLoading(true);

  // Reuse the in-memory pool for manual refreshes.
  if (!forceNew && featuredPool.length > 0) {
    const meal = pickFeaturedCandidate(getLastFeaturedId());
    if (meal) {
      renderFeatured(meal);
      setFeaturedLoading(false);
      return;
    }
  }

  if (forceNew && featuredPool.length > 1) {
    const meal = pickFeaturedCandidate(featuredMeal ? featuredMeal.idMeal : '');
    if (meal) {
      renderFeatured(meal);
      setFeaturedLoading(false);
      return;
    }
  }

  loadFeaturedPool()
    .then(pool => {
      featuredPool = pool;

      if (pool.length === 0) {
        // Fallback: ask the existing random endpoint for one real recipe.
        return fetchRandomRecipe().then(result => {
          if (result.error || !result.meals || result.meals.length === 0) {
            showFeaturedError();
            return;
          }
          if (isSuitableFeatured(result.meals[0])) {
            renderFeatured(result.meals[0]);
          } else {
            showFeaturedError();
          }
        });
      }

      // On launch, avoid the recipe that was featured last time.
      const excludeId = forceNew && featuredMeal ? featuredMeal.idMeal : getLastFeaturedId();
      const meal = pickFeaturedCandidate(excludeId);
      if (meal) {
        renderFeatured(meal);
      } else {
        showFeaturedError();
      }
    })
    .catch(() => showFeaturedError())
    .finally(() => setFeaturedLoading(false));
}

/* 
   8. RECIPE RESULTS AND CATEGORY FILTERING
   Lunch and Dinner are grouped from real TheMealDB categories so those
   filter buttons return useful recipes.
    */
const CATEGORY_GROUPS = {
  Lunch: ['Pasta', 'Side', 'Starter'],
  Dinner: ['Beef', 'Chicken', 'Seafood']
};

// Return a list of recipes for one filter button.
function fetchRecipesForCategory(category) {
  if (!category || category === 'All') {
    return fetchRecipesByName('chicken');
  }

  // Student-written if/else: grouped filters merge several API categories.
  if (CATEGORY_GROUPS[category]) {
    const categories = CATEGORY_GROUPS[category];
    return Promise.all(categories.map(item => fetchRecipesByCategory(item))).then(results => {
      const recipesById = new Map();

      results.forEach(result => {
        if (result.error || !Array.isArray(result.meals)) return;
        result.meals.forEach(meal => {
          if (!recipesById.has(meal.idMeal)) recipesById.set(meal.idMeal, meal);
        });
      });

      const meals = Array.from(recipesById.values());
      if (meals.length === 0) return { meals: null };
      return { meals: meals };
    });
  }

  return fetchRecipesByCategory(category);
}

// Render API recipes as cards. Each card opens the recipe detail modal.
function displayRecipes(meals, containerId, messageId, categoryLabel) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';
  setStatus(messageId, '');

  if (!meals || meals.length === 0) {
    showEmptyState(containerId, 'No recipes found.', 'Try another search or category.');
    setStatus(messageId, 'No recipes found.', 'error');
    return;
  }

  meals.forEach(meal => {
    const card = document.createElement('article');
    card.className = 'recipe-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `View ${meal.strMeal}`);
    card.innerHTML = `
      <div class="recipe-card-image">
        <img alt="${escapeHtml(meal.strMeal)}" loading="lazy">
      </div>
      <div class="recipe-card-info">
        <h3 class="recipe-card-name">${escapeHtml(meal.strMeal)}</h3>
        <p class="recipe-card-meta">${escapeHtml(meal.strCategory || categoryLabel || 'Recipe')}${meal.strArea ? ` · ${escapeHtml(meal.strArea)}` : ''}</p>
        <button class="btn btn-accent btn-sm recipe-view-btn" type="button">
          View Recipe <span aria-hidden="true">→</span>
        </button>
      </div>
    `;

    setImageSource(card.querySelector('img'), meal.strMealThumb, meal.strMeal);

    const open = () => openRecipeModal(meal);
    card.querySelector('.recipe-view-btn').addEventListener('click', event => {
      event.stopPropagation();
      open();
    });
    card.addEventListener('click', open);
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });

    container.appendChild(card);
  });

  setStatus(messageId, `${meals.length} recipe${meals.length === 1 ? '' : 's'} found.`, 'success');
}

/* 
   9. MEAL PLAN INTERFACE
   The form calls the MealPlanManager CRUD methods and displays feedback.
    */
function renderMealPlans() {
  const list = document.getElementById('mealPlanList');
  if (!list) return;

  list.innerHTML = '';
  const plans = mealPlanManager.getAll();

  if (plans.length === 0) {
    showEmptyState(
      'mealPlanList',
      'No meal plans yet.',
      'Add your first plan using the form above.'
    );
    return;
  }

  plans.forEach(plan => {
    const item = document.createElement('article');
    item.className = 'mealplan-card';
    item.innerHTML = `
      <div class="mealplan-card-header">
        <h3>${escapeHtml(plan.name || 'Meal Plan')}</h3>
        <span>ID: ${escapeHtml(String(plan.id))}</span>
      </div>
      <div class="mealplan-card-body">
        <p><strong>Recipe:</strong> ${escapeHtml(plan.recipe || '')}</p>
      </div>
      <div class="mealplan-card-actions">
        <button class="btn btn-secondary btn-sm mealplan-edit" type="button">Edit</button>
        <button class="btn btn-danger btn-sm mealplan-delete" type="button">Delete</button>
      </div>
    `;

    item.querySelector('.mealplan-delete').addEventListener('click', () => {
      if (!confirm('Delete this meal plan?')) return;
      const result = mealPlanManager.delete(plan.id);
      setStatus('mealPlanMessage', result.message, result.success ? 'success' : 'error');
      renderMealPlans();
    });

    item.querySelector('.mealplan-edit').addEventListener('click', () => {
      document.getElementById('mealPlanId').value = plan.id;
      document.getElementById('mealPlanName').value = plan.name || '';
      document.getElementById('mealPlanRecipe').value = plan.recipe || '';
      setStatus('mealPlanMessage', 'Update the details and click Update Plan.');
      document.getElementById('mealPlanName').focus();
    });

    list.appendChild(item);
  });
}

/* 
   10. EVENT LISTENERS AND APP START-UP
   All buttons keep their existing IDs, so the original actions still work.
    */
document.addEventListener('DOMContentLoaded', () => {
  const navButtons = document.querySelectorAll('.nav-btn[data-view]');
  const categoryButtons = document.querySelectorAll('.cat-btn');
  const searchInput = document.getElementById('searchInput');
  const modal = document.getElementById('recipeModal');

  // Initial data: saved meal plans, cookbook, suggestions and featured recipe.
  renderMealPlans();
  renderCookbook();
  getRecipeSuggestionsByCategory('All').then(result => displaySuggestions(result, 'All'));

  // Load an initial set of recipes (search results are cached for the session).
  showLoadingState('results', 'Loading recipes…');
  fetchRecipesByName('chicken').then(result => {
    if (result.error || !result.meals) {
      showEmptyState('results', 'Recipes could not be loaded.', 'Please check your connection and try again.');
      setStatus('message', "We couldn't load recipes.", 'error');
      return;
    }
    displayRecipes(result.meals, 'results', 'message', 'All');
  });

  loadFeaturedRecipe(false);

  // Sidebar view switching.
  navButtons.forEach(button => {
    button.addEventListener('click', () => showView(button.dataset.view));
  });

  // "My Cookbook" lives inside the Discover view, so switch views first
  // before scrolling to it. This keeps the sidebar link working everywhere.
  document.querySelectorAll('.nav-btn.nav-link').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      showView('discover');
      const section = document.getElementById('cookbook');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Category filters also refresh suggestions.
  categoryButtons.forEach(button => {
    button.addEventListener('click', () => {
      categoryButtons.forEach(item => item.classList.remove('active'));
      button.classList.add('active');
      loadCategory(button.dataset.category);
    });
  });

  function loadCategory(category) {
    showLoadingState('suggestionResult', 'Loading suggestions…');
    showLoadingState('results', 'Loading recipes…');
    setStatus('suggestionStatus', '');
    setStatus('message', '');

    getRecipeSuggestionsByCategory(category).then(result => displaySuggestions(result, category));

    fetchRecipesForCategory(category).then(result => {
      if (result.error || !result.meals) {
        showEmptyState('results', 'Recipes could not be loaded.', 'Please check your connection and try again.');
        setStatus('message', "We couldn't load recipes.", 'error');
        return;
      }
      displayRecipes(result.meals, 'results', 'message', category);
    });
  }

  // Search by recipe name.
  function runSearch() {
    const name = searchInput.value.trim();
    if (!name) {
      setStatus('message', 'Enter a recipe name.', 'error');
      searchInput.focus();
      return;
    }

    setStatus('message', '');
    showLoadingState('results', 'Searching recipes…');

    fetchRecipesByName(name).then(result => {
      if (result.error) {
        showEmptyState('results', 'Recipes could not be loaded.', 'Please check your connection and try again.');
        setStatus('message', "We couldn't load recipes.", 'error');
        return;
      }
      displayRecipes(result.meals, 'results', 'message', 'Search result');
    });
  }

  document.getElementById('searchBtn').addEventListener('click', runSearch);
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') runSearch();
  });

  // Random recipe button.
  document.getElementById('randomBtn').addEventListener('click', () => {
    showLoadingState('results', 'Finding a recipe…');
    setStatus('message', '');

    fetchRandomRecipe().then(result => {
      if (result.error || !result.meals) {
        showEmptyState('results', 'Recipe could not be loaded.', 'Please check your connection and try again.');
        setStatus('message', "We couldn't load a recipe.", 'error');
        return;
      }
      displayRecipes(result.meals, 'results', 'message', 'Random recipe');
    });
  });

  // Featured recipe refresh button.
  document.getElementById('featuredRefreshBtn').addEventListener('click', () => {
    loadFeaturedRecipe(true);
  });

  document.getElementById('featuredViewBtn').addEventListener('click', () => {
    if (featuredMeal) openRecipeModal(featuredMeal);
  });

  // Modal close: X button, backdrop click and Escape key.
  document.getElementById('modalClose').addEventListener('click', closeRecipeModal);
  modal.addEventListener('click', event => {
    if (event.target === modal) closeRecipeModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal.classList.contains('active')) closeRecipeModal();
  });

  // Save the currently open recipe to the cookbook.
  document.getElementById('modalCookbookBtn').addEventListener('click', () => {
    if (!activeModalMeal) return;
    const result = addToCookbook(activeModalMeal);
    setStatus('modalStatus', result.message, result.success ? 'success' : 'error');

    if (result.success) {
      const button = document.getElementById('modalCookbookBtn');
      const originalText = button.textContent;
      button.textContent = 'Saved';
      button.disabled = true;
      setTimeout(() => {
        button.textContent = originalText;
        button.disabled = false;
      }, 1400);
    }
  });

  // Open the full recipe page for the modal recipe.
  document.getElementById('modalFullRecipeBtn').addEventListener('click', () => {
    if (activeModalMeal) openRecipePage(activeModalMeal.idMeal);
  });

  // CREATE a meal plan.
  document.getElementById('addMealPlanBtn').addEventListener('click', () => {
    const name = document.getElementById('mealPlanName').value.trim();
    const recipe = document.getElementById('mealPlanRecipe').value.trim();

    if (!name || !recipe) {
      setStatus('mealPlanMessage', 'Enter a plan name and recipe name.', 'error');
      return;
    }

    const plan = new MealPlan(Date.now().toString(), name, recipe);
    const result = mealPlanManager.create(plan);

    setStatus('mealPlanMessage', result.message, result.success ? 'success' : 'error');
    if (result.success) {
      document.getElementById('mealPlanId').value = '';
      document.getElementById('mealPlanName').value = '';
      document.getElementById('mealPlanRecipe').value = '';
      renderMealPlans();
    }
  });

  // UPDATE an existing meal plan.
  document.getElementById('updateMealPlanBtn').addEventListener('click', () => {
    const id = document.getElementById('mealPlanId').value.trim();
    const name = document.getElementById('mealPlanName').value.trim();
    const recipe = document.getElementById('mealPlanRecipe').value.trim();

    if (!id) {
      setStatus('mealPlanMessage', 'Enter or select a meal plan ID to update.', 'error');
      document.getElementById('mealPlanId').focus();
      return;
    }
    if (!name && !recipe) {
      setStatus('mealPlanMessage', 'Enter a new plan name or recipe name.', 'error');
      return;
    }

    const plan = new MealPlan(id, name, recipe);
    const result = mealPlanManager.update(plan);

    setStatus('mealPlanMessage', result.message, result.success ? 'success' : 'error');
    if (result.success) {
      document.getElementById('mealPlanId').value = '';
      document.getElementById('mealPlanName').value = '';
      document.getElementById('mealPlanRecipe').value = '';
      renderMealPlans();
    }
  });

  // READ / refresh the meal plan list.
  document.getElementById('loadMealPlansBtn').addEventListener('click', () => {
    renderMealPlans();
    setStatus('mealPlanMessage', 'Meal plans refreshed.', 'success');
  });

  // "Create Meal Plan" switches to the form and clears old values.
  document.getElementById('createMealPlanBtn').addEventListener('click', () => {
    showView('mealplans');
    document.getElementById('mealPlanId').value = '';
    document.getElementById('mealPlanName').value = '';
    document.getElementById('mealPlanRecipe').value = '';
    setStatus('mealPlanMessage', 'Enter details and click Add Plan.');
    document.getElementById('mealPlanName').focus();
  });

  // Serving ratio calculator on the meal plan page.
  document.getElementById('calcBtn').addEventListener('click', () => {
    const original = parseFloat(document.getElementById('calcOrig').value);
    const desired = parseFloat(document.getElementById('calcDesired').value);
    const resultBox = document.getElementById('calcResult');

    if (isNaN(original) || isNaN(desired) || original <= 0 || desired <= 0) {
      setStatus('calcMessage', 'Enter valid serving numbers greater than zero.', 'error');
      resultBox.textContent = '';
      resultBox.classList.remove('is-visible');
      return;
    }

    const ratio = desired / original;
    setStatus('calcMessage', 'Calculation complete.', 'success');
    resultBox.textContent = `Scale every ingredient by ${ratio.toFixed(2)} (${original} → ${desired} servings).`;
    resultBox.classList.add('is-visible');
  });

  // Support links such as index.html?view=mealplans and #cookbook.
  const params = new URLSearchParams(window.location.search);
  if (params.get('view') === 'mealplans') {
    showView('mealplans');
  } else if (window.location.hash === '#cookbook') {
    setTimeout(() => {
      const section = document.getElementById('cookbook');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  }
});
