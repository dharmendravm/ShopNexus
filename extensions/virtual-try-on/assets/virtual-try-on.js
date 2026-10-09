/**
 * =============================================================================
 * FILE: virtual-try-on.js
 * ROLE: Storefront Virtual Try-On Widget (Lookfly Style Premium UI)
 * =============================================================================
 *
 * Yeh file kahan se aati hai?
 *   Theme App Extension → blocks/virtual-try-on.liquid ke schema mein
 *   `"javascript": "virtual-try-on.js"` configuration ke throug load hoti hai.
 *
 * Full Customer Experience Flow:
 *   1. Storefront par Product Page launch -> Main in-page button + Floating side tab render hote hain.
 *   2. User click karta hai -> Lookfly style floating card popup/drawer open hota hai.
 *   3. Step 1 (Upload): User photo select/drag-drop karta hai -> Client-side size & type validate
 *      hota hai -> Canvas compressed Data URL banta hai -> Preview dikhta hai.
 *   4. Step 2 (Loading): "Try it on virtually" click par animated progress bar (10% -> 100%)
 *      chalta hai, Garment + User photo side-by-side display hote hain, aur `/apps/virtual-try-on` Proxy API call hoti hai.
 *   5. Step 3 (Result): Result image render hoti hai -> User fullscreen lightbox expand,
 *      feedback (thumbs up/down), WhatsApp/Web Share, ya direct "Add to Cart" kar sakta hai.
 *
 * Production Guidelines:
 *   - Selective data attributes `data-vto-*` use kiye gaye hain.
 *   - Shopify App Proxy path `/apps/virtual-try-on` ke throug backend server se communicate karta hai.
 *   - Automatic memory cleanup through WeakMap for Theme Editor re-renders.
 * =============================================================================
 */
(function () {
  "use strict";

  /**
   * Storefront App Proxy route path.
   * Shopify store network handles: `https://store.com/apps/virtual-try-on` -> backend app
   * @constant {string}
   */
  var APP_PROXY_TRY_ON_PATH = "/apps/virtual-try-on";

  /**
   * Max photo upload limit = 5 MB.
   * @constant {number}
   */
  var MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

  /**
   * Image compression target size (max width/height px).
   * @constant {number}
   */
  var MAX_IMAGE_EDGE_PX = 1280;

  /**
   * JPEG quality ratio (0.85 balance speed & visual clarity).
   * @constant {number}
   */
  var JPEG_QUALITY = 0.85;

  /**
   * Allowed uploaded image extensions.
   * @constant {string[]}
   */
  var ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

  /**
   * Cleanup functions map per root widget for Shopify Theme Customizer compatibility.
   * @type {WeakMap<Element, Function>}
   */
  var widgetCleanups = new WeakMap();

  /**
   * Page load aur Shopify customizer events par saare Virtual Try-On widgets initializes karta hai.
   * @returns {void}
   */
  function initAllVirtualTryOnWidgets() {
    var roots = document.querySelectorAll("[data-vto-widget]");
    roots.forEach(function (widgetRoot) {
      destroyWidget(widgetRoot);
      setupWidget(widgetRoot);
    });
  }

  /**
   * Existing widget instances and event listeners को remove karta hai (Memory leaks avoidance).
   * @param {Element} widgetRoot
   * @returns {void}
   */
  function destroyWidget(widgetRoot) {
    var cleanup = widgetCleanups.get(widgetRoot);
    if (typeof cleanup === "function") {
      cleanup();
      widgetCleanups.delete(widgetRoot);
    }
  }

  /**
   * Main setup function: Ek specific block widget ke HTML, CSS aur Events ko wireup karta hai.
   * @param {Element} widgetRoot - `[data-vto-widget]` container
   * @returns {void}
   */
  function setupWidget(widgetRoot) {
    // Liquid attributes extraction
    var blockId = widgetRoot.getAttribute("data-vto-block-id");
    var productId = widgetRoot.getAttribute("data-vto-product-id");
    var variantId = normalizeVariantId(widgetRoot.getAttribute("data-vto-variant-id"));
    var garmentImageUrl = widgetRoot.getAttribute("data-vto-garment-image-url") || "";
    var garmentCategory = widgetRoot.getAttribute("data-vto-garment-category") || "tops";
    var productTitle = widgetRoot.getAttribute("data-vto-product-title") || "Product";

    // Modals and side tabs binding
    var modal = document.getElementById("vto-modal-" + blockId);
    var sideTab = document.querySelector('[data-vto-side-tab-id="' + blockId + '"]');

    if (!modal) {
      console.warn("[VirtualTryOn] Modal element missing for block ID:", blockId);
      return;
    }

    // Modal and Lightbox को Body tag level par relocate karna (Shopify CSS clipping protection)
    if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }

    var lightbox = modal.querySelector("[data-vto-lightbox]");
    if (lightbox && lightbox.parentElement !== document.body) {
      document.body.appendChild(lightbox);
    }

    // DOM Elements Queries
    var openButton = widgetRoot.querySelector("[data-vto-open-button]");
    var closeButton = modal.querySelector("[data-vto-close-button]");
    var backdrop = modal.querySelector("[data-vto-modal-backdrop]");

    var stepUpload = modal.querySelector('[data-vto-step="upload"]');
    var stepLoading = modal.querySelector('[data-vto-step="loading"]');
    var stepResult = modal.querySelector('[data-vto-step="result"]');

    var photoDropzone = modal.querySelector("[data-vto-photo-dropzone]");
    var photoFileInput = modal.querySelector("[data-vto-photo-file-input]");
    var photoUploadPrompt = modal.querySelector("[data-vto-photo-upload-prompt]");
    var customerPhotoPreview = modal.querySelector("[data-vto-customer-photo-preview]");
    var customerPhotoImage = modal.querySelector("[data-vto-customer-photo-image]");
    var changePhotoButton = modal.querySelector("[data-vto-change-photo-button]");
    var errorMessageEl = modal.querySelector("[data-vto-error-message]");
    var generateButton = modal.querySelector("[data-vto-generate-button]");

    var loadingUserImage = modal.querySelector("[data-vto-loading-user-image]");
    var progressFill = modal.querySelector("[data-vto-progress-fill]");
    var progressText = modal.querySelector("[data-vto-progress-text]");

    var resultImage = modal.querySelector("[data-vto-result-image]");
    var expandButton = modal.querySelector("[data-vto-expand-button]");
    var retryButton = modal.querySelector("[data-vto-retry-button]");
    var addToCartButton = modal.querySelector("[data-vto-add-to-cart-button]");
    var whatsappShareBtn = modal.querySelector("[data-vto-share-whatsapp]");
    var generalShareBtn = modal.querySelector("[data-vto-share-general]");
    var feedbackButtons = modal.querySelectorAll("[data-vto-feedback]");

    var lightboxImage = lightbox ? lightbox.querySelector("[data-vto-lightbox-image]") : null;
    var lightboxCloseBtn = lightbox ? lightbox.querySelector("[data-vto-lightbox-close]") : null;

    // Component State
    var selectedPersonImageDataUri = null;
    var isGenerating = false;
    var activeAbortController = null;
    var progressInterval = null;
    var currentProgressPercent = 10;
    var listeners = [];

    /**
     * Helper to safely bind event listeners with dynamic memory cleanup tracking.
     */
    function on(target, eventName, handler, options) {
      if (!target) return;
      target.addEventListener(eventName, handler, options);
      listeners.push({ target: target, eventName: eventName, handler: handler, options: options });
    }

    /**
     * Controls active wizard step visibility.
     */
    function showStep(stepElement) {
      [stepUpload, stepLoading, stepResult].forEach(function (step) {
        if (step) step.classList.add("is-hidden");
      });
      if (stepElement) stepElement.classList.remove("is-hidden");
    }

    /**
     * Display UI error notification banner.
     */
    function showError(message) {
      if (!errorMessageEl) return;
      errorMessageEl.textContent = message;
      errorMessageEl.classList.remove("is-hidden");
    }

    /**
     * Clear error banner.
     */
    function hideError() {
      if (!errorMessageEl) return;
      errorMessageEl.textContent = "";
      errorMessageEl.classList.add("is-hidden");
    }

    /**
     * Open Try-On Modal Card.
     */
    function openModal() {
      modal.classList.remove("is-hidden");
      modal.setAttribute("aria-hidden", "false");
      if (sideTab) sideTab.classList.add("is-hidden");
      showStep(stepUpload);
    }

    /**
     * Close Try-On Modal Card.
     */
    function closeModal() {
      if (isGenerating && activeAbortController) {
        activeAbortController.abort();
      }
      stopProgressAnimation();
      modal.classList.add("is-hidden");
      modal.setAttribute("aria-hidden", "true");
      if (sideTab) sideTab.classList.remove("is-hidden");
      closeLightbox();
    }

    /**
     * Fullscreen Lightbox Open.
     */
    function openLightbox() {
      if (!lightbox || !resultImage || !resultImage.src) return;
      if (lightboxImage) lightboxImage.src = resultImage.src;
      lightbox.classList.remove("is-hidden");
      lightbox.setAttribute("aria-hidden", "false");
    }

    /**
     * Fullscreen Lightbox Close.
     */
    function closeLightbox() {
      if (!lightbox) return;
      lightbox.classList.add("is-hidden");
      lightbox.setAttribute("aria-hidden", "true");
    }

    /**
     * Resets upload UI state.
     */
    function resetUploadState() {
      selectedPersonImageDataUri = null;
      if (photoFileInput) photoFileInput.value = "";
      if (customerPhotoImage) customerPhotoImage.removeAttribute("src");
      if (loadingUserImage) loadingUserImage.removeAttribute("src");
      if (photoUploadPrompt) photoUploadPrompt.classList.remove("is-hidden");
      if (customerPhotoPreview) customerPhotoPreview.classList.add("is-hidden");
      if (photoDropzone) photoDropzone.classList.remove("has-preview");
      if (generateButton) generateButton.disabled = true;
      hideError();
    }

    /**
     * Updates loading button state during active GPU backend inference.
     */
    function setGeneratingState(nextIsGenerating) {
      isGenerating = nextIsGenerating;
      if (generateButton) {
        generateButton.disabled = nextIsGenerating || !selectedPersonImageDataUri;
      }
      if (openButton) openButton.disabled = nextIsGenerating;
    }

    /**
     * Progress bar timer animation (10% to ~90% while waiting for GPU API).
     */
    function startProgressAnimation() {
      stopProgressAnimation();
      currentProgressPercent = 10;
      updateProgressUI(currentProgressPercent);

      progressInterval = setInterval(function () {
        if (currentProgressPercent < 90) {
          // Dynamic increment rate slowing down near 90%
          var step = currentProgressPercent < 50 ? 4 : (currentProgressPercent < 75 ? 2 : 1);
          currentProgressPercent += step;
          updateProgressUI(currentProgressPercent);
        }
      }, 350);
    }

    /**
     * Stops progress bar timer interval.
     */
    function stopProgressAnimation() {
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
    }

    /**
     * Sets progress bar fill width & text string.
     */
    function updateProgressUI(percent) {
      if (progressFill) progressFill.style.width = percent + "%";
      if (progressText) progressText.textContent = percent + "%";
    }

    /**
     * Client-side uploaded file validation.
     */
    function validateImageFile(file) {
      if (!file) return "Please choose a photo.";
      var fileName = file.name || "";
      var extension = fileName.substring(fileName.lastIndexOf(".")).toLowerCase();
      var hasImageMime = file.type ? file.type.indexOf("image/") === 0 : false;
      var hasAllowedExtension = ALLOWED_EXTENSIONS.indexOf(extension) !== -1;

      if (!hasImageMime && !hasAllowedExtension) {
        return "Please upload a valid JPG, PNG, or WebP photo.";
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return "Photo size is too large. Please upload an image under 5MB.";
      }
      return null;
    }

    /**
     * Canvas image downsizing and compression to JPEG base64 Data URI.
     */
    function compressImageFile(file) {
      return new Promise(function (resolve, reject) {
        var objectUrl = URL.createObjectURL(file);
        var image = new Image();

        image.onload = function () {
          try {
            var width = image.naturalWidth || image.width;
            var height = image.naturalHeight || image.height;
            var scale = Math.min(1, MAX_IMAGE_EDGE_PX / Math.max(width, height));
            var targetWidth = Math.max(1, Math.round(width * scale));
            var targetHeight = Math.max(1, Math.round(height * scale));

            var canvas = document.createElement("canvas");
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            var context = canvas.getContext("2d");
            if (!context) {
              URL.revokeObjectURL(objectUrl);
              reject(new Error("Could not initialize canvas image compressor."));
              return;
            }

            context.drawImage(image, 0, 0, targetWidth, targetHeight);
            var outputMime = file.type === "image/png" ? "image/png" : "image/jpeg";
            var dataUri = canvas.toDataURL(
              outputMime,
              outputMime === "image/jpeg" ? JPEG_QUALITY : undefined
            );
            URL.revokeObjectURL(objectUrl);
            resolve(dataUri);
          } catch (err) {
            URL.revokeObjectURL(objectUrl);
            reject(err);
          }
        };

        image.onerror = function () {
          URL.revokeObjectURL(objectUrl);
          reject(new Error("Failed to load image file."));
        };

        image.src = objectUrl;
      });
    }

    /**
     * Selected user file handler.
     */
    async function handleSelectedFile(file) {
      hideError();
      var validationError = validateImageFile(file);
      if (validationError) {
        showError(validationError);
        return;
      }

      try {
        selectedPersonImageDataUri = await compressImageFile(file);
        if (customerPhotoImage) customerPhotoImage.src = selectedPersonImageDataUri;
        if (loadingUserImage) loadingUserImage.src = selectedPersonImageDataUri;
        if (photoUploadPrompt) photoUploadPrompt.classList.add("is-hidden");
        if (customerPhotoPreview) customerPhotoPreview.classList.remove("is-hidden");
        if (photoDropzone) photoDropzone.classList.add("has-preview");
        if (generateButton) generateButton.disabled = false;
      } catch (err) {
        selectedPersonImageDataUri = null;
        showError(err.message || "Failed to process photo. Please select another image.");
      }
    }

    /**
     * Primary backend API caller via App Proxy `/apps/virtual-try-on`.
     */
    async function generateTryOn() {
      if (isGenerating) return;
      if (!selectedPersonImageDataUri) {
        showError("Please upload your photo first.");
        return;
      }
      if (!garmentImageUrl) {
        showError("Product image unavailable for virtual try-on.");
        return;
      }

      hideError();
      setGeneratingState(true);
      showStep(stepLoading);
      startProgressAnimation();

      activeAbortController = new AbortController();

      try {
        var response = await fetch(APP_PROXY_TRY_ON_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: activeAbortController.signal,
          body: JSON.stringify({
            personImage: selectedPersonImageDataUri,
            garmentImageUrl: garmentImageUrl,
            productId: productId,
            variantId: variantId,
            category: garmentCategory,
          }),
        });

        var contentType = response.headers.get("content-type") || "";
        if (contentType.indexOf("application/json") === -1) {
          stopProgressAnimation();
          showStep(stepUpload);
          showError(
            response.status === 404
              ? "Virtual Try-On App Proxy is not reachable. Please check backend tunnel."
              : "Server response error. Please try again."
          );
          return;
        }

        var data = await response.json();

        if (response.ok && data.success && data.tryOnImage) {
          // Smooth finish to 100% progress
          stopProgressAnimation();
          updateProgressUI(100);

          setTimeout(function () {
            if (resultImage) resultImage.src = data.tryOnImage;
            showStep(stepResult);
          }, 300);
          return;
        }

        stopProgressAnimation();
        showStep(stepUpload);
        showError(data.error || "Virtual Try-On failed. Please try again.");
      } catch (err) {
        stopProgressAnimation();
        if (err && err.name === "AbortError") {
          showStep(stepUpload);
          return;
        }
        showStep(stepUpload);
        showError("Network connection error. Please try again.");
      } finally {
        activeAbortController = null;
        setGeneratingState(false);
      }
    }

    /**
     * Ajax cart checkout via `/cart/add.js`.
     */
    async function addCurrentVariantToCart() {
      if (!variantId || !addToCartButton) return;

      var originalText = addToCartButton.textContent;
      addToCartButton.disabled = true;
      addToCartButton.textContent = "Adding...";

      try {
        var response = await fetch("/cart/add.js", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [{ id: Number(variantId), quantity: 1 }],
          }),
        });

        if (response.ok) {
          addToCartButton.textContent = "Added to Cart!";
          setTimeout(function () {
            window.location.href = "/cart";
          }, 450);
          return;
        }

        window.location.href = "/cart/add?id=" + encodeURIComponent(variantId) + "&quantity=1";
      } catch (err) {
        window.location.href = "/cart/add?id=" + encodeURIComponent(variantId) + "&quantity=1";
      } finally {
        setTimeout(function () {
          addToCartButton.disabled = false;
          addToCartButton.textContent = originalText;
        }, 1500);
      }
    }

    /**
     * Social sharing - WhatsApp link.
     */
    function shareOnWhatsApp() {
      var text = "Check out my Virtual Try-On look for " + productTitle + "! " + window.location.href;
      var whatsappUrl = "https://api.whatsapp.com/send?text=" + encodeURIComponent(text);
      window.open(whatsappUrl, "_blank");
    }

    /**
     * Web Share API / Clipboard fallback link sharing.
     */
    function shareGeneral() {
      if (navigator.share) {
        navigator.share({
          title: "Virtual Try-On - " + productTitle,
          text: "Check out my Virtual Try-On look!",
          url: window.location.href,
        }).catch(function () {});
      } else if (navigator.clipboard && window.location.href) {
        navigator.clipboard.writeText(window.location.href).then(function () {
          alert("Product link copied to clipboard!");
        });
      }
    }

    // =========================================================================
    // Event Wiring & Event Handlers
    // =========================================================================

    // Open Modal Triggers (Main button & Floating side tab)
    on(openButton, "click", function (e) {
      e.preventDefault();
      openModal();
    });

    on(sideTab, "click", function (e) {
      e.preventDefault();
      openModal();
    });

    // Close Modal Triggers
    on(closeButton, "click", closeModal);
    on(backdrop, "click", closeModal);

    // Lightbox Triggers
    on(expandButton, "click", openLightbox);
    on(lightboxCloseBtn, "click", closeLightbox);
    if (lightbox) {
      var lightboxBackdrop = lightbox.querySelector(".vto-fullscreen-lightbox");
      on(lightbox, "click", function (e) {
        if (e.target === lightbox) closeLightbox();
      });
    }

    // Escape Key Handler for Modals & Lightbox
    on(document, "keydown", function (e) {
      if (e.key === "Escape" || e.keyCode === 27) {
        if (lightbox && !lightbox.classList.contains("is-hidden")) {
          closeLightbox();
        } else if (modal && !modal.classList.contains("is-hidden")) {
          closeModal();
        }
      }
    });

    // Photo File Upload Handlers
    on(photoFileInput, "change", function (e) {
      var files = e.target && e.target.files;
      if (files && files[0]) handleSelectedFile(files[0]);
    });

    on(changePhotoButton, "click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      resetUploadState();
      if (photoFileInput) photoFileInput.click();
    });

    // Drag-and-drop feedback
    ["dragenter", "dragover"].forEach(function (evt) {
      on(photoDropzone, evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (photoDropzone) photoDropzone.classList.add("is-dragover");
      });
    });

    ["dragleave", "drop"].forEach(function (evt) {
      on(photoDropzone, evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (photoDropzone) photoDropzone.classList.remove("is-dragover");
      });
    });

    on(photoDropzone, "drop", function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) handleSelectedFile(files[0]);
    });

    // Generate Try-On Button Handler
    on(generateButton, "click", function () {
      generateTryOn();
    });

    // Retry / Change Photo Link Handler
    on(retryButton, "click", function () {
      stopProgressAnimation();
      showStep(stepUpload);
    });

    // Add to Cart Button Handler
    on(addToCartButton, "click", function () {
      addCurrentVariantToCart();
    });

    // Share Buttons Handlers
    on(whatsappShareBtn, "click", shareOnWhatsApp);
    on(generalShareBtn, "click", shareGeneral);

    // Feedback Rating Buttons (Thumbs Up / Down) Handlers
    feedbackButtons.forEach(function (btn) {
      on(btn, "click", function () {
        feedbackButtons.forEach(function (b) { b.classList.remove("is-active"); });
        btn.classList.add("is-active");
      });
    });

    // WeakMap cleanup handler registration for theme live preview updates
    widgetCleanups.set(widgetRoot, function cleanup() {
      if (activeAbortController) activeAbortController.abort();
      stopProgressAnimation();
      listeners.forEach(function (entry) {
        entry.target.removeEventListener(entry.eventName, entry.handler, entry.options);
      });
      listeners = [];

      if (modal && modal.parentElement === document.body) {
        modal.remove();
      }
      if (lightbox && lightbox.parentElement === document.body) {
        lightbox.remove();
      }
    });
  }

  /**
   * Helper function to extract numerical Shopify variant ID.
   */
  function normalizeVariantId(rawVariantId) {
    if (!rawVariantId) return "";
    var value = String(rawVariantId).trim();
    var gidMatch = value.match(/ProductVariant\/(\d+)/);
    if (gidMatch) return gidMatch[1];
    if (/^\d+$/.test(value)) return value;
    return value;
  }

  // ===========================================================================
  // Initialization & Event Attachments
  // ===========================================================================

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAllVirtualTryOnWidgets);
  } else {
    initAllVirtualTryOnWidgets();
  }

  document.addEventListener("shopify:section:load", initAllVirtualTryOnWidgets);
  document.addEventListener("shopify:section:unload", function (event) {
    if (!event || !event.target) return;
    event.target.querySelectorAll("[data-vto-widget]").forEach(destroyWidget);
  });
})();
