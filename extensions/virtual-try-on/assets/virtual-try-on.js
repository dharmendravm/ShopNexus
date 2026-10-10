/**
 * =============================================================================
 * FILE: virtual-try-on.js
 * ROLE: Storefront Virtual Try-On Widget (Lookfly / CleverCat UI)
 * =============================================================================
 */
(function () {
  "use strict";

  var APP_PROXY_TRY_ON_PATH = "/apps/virtual-try-on";
  var MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
  var MAX_IMAGE_EDGE_PX = 1280;
  var JPEG_QUALITY = 0.85;
  var ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

  var widgetCleanups = new WeakMap();

  function initAllVirtualTryOnWidgets() {
    var roots = document.querySelectorAll("[data-vto-widget]");
    roots.forEach(function (widgetRoot) {
      destroyWidget(widgetRoot);
      setupWidget(widgetRoot);
    });
  }

  function destroyWidget(widgetRoot) {
    var cleanup = widgetCleanups.get(widgetRoot);
    if (typeof cleanup === "function") {
      cleanup();
      widgetCleanups.delete(widgetRoot);
    }
  }

  function setupWidget(widgetRoot) {
    var blockId = widgetRoot.getAttribute("data-vto-block-id");
    var productId = widgetRoot.getAttribute("data-vto-product-id");
    var variantId = normalizeVariantId(widgetRoot.getAttribute("data-vto-variant-id"));
    var garmentImageUrl = (widgetRoot.getAttribute("data-vto-garment-image-url") || "").trim();
    if (garmentImageUrl) {
      garmentImageUrl = garmentImageUrl.replace(/^(https?:)+/i, "https:");
      if (garmentImageUrl.startsWith("//")) {
        garmentImageUrl = "https:" + garmentImageUrl;
      }
    }
    var garmentCategory = widgetRoot.getAttribute("data-vto-garment-category") || "tops";

    var modal = document.getElementById("vto-modal-" + blockId);
    var sideTab = document.querySelector('[data-vto-side-tab-id="' + blockId + '"]');
    var lightbox = document.getElementById("vto-lightbox-" + blockId) || document.querySelector('[data-vto-lightbox-id="' + blockId + '"]');

    if (!modal) {
      console.warn("[VirtualTryOn] Modal element missing for block ID:", blockId);
      return;
    }

    if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
    if (lightbox && lightbox.parentElement !== document.body) {
      document.body.appendChild(lightbox);
    }

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

    var lightboxImage = lightbox ? lightbox.querySelector("[data-vto-lightbox-image]") : null;
    var lightboxCloseBtn = lightbox ? lightbox.querySelector("[data-vto-lightbox-close]") : null;

    var selectedPersonImageDataUri = null;
    var isGenerating = false;
    var activeAbortController = null;
    var progressInterval = null;
    var currentProgressPercent = 10;
    var listeners = [];

    function on(target, eventName, handler, options) {
      if (!target) return;
      target.addEventListener(eventName, handler, options);
      listeners.push({ target: target, eventName: eventName, handler: handler, options: options });
    }

    function showStep(stepElement) {
      [stepUpload, stepLoading, stepResult].forEach(function (step) {
        if (step) step.classList.add("is-hidden");
      });
      if (stepElement) stepElement.classList.remove("is-hidden");
    }

    function showError(message) {
      if (!errorMessageEl) return;
      errorMessageEl.textContent = message;
      errorMessageEl.classList.remove("is-hidden");
    }

    function hideError() {
      if (!errorMessageEl) return;
      errorMessageEl.textContent = "";
      errorMessageEl.classList.add("is-hidden");
    }

    function openModal() {
      modal.classList.remove("is-hidden");
      modal.setAttribute("aria-hidden", "false");
      if (sideTab) sideTab.classList.add("is-hidden");
      showStep(stepUpload);
    }

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

    function openLightbox() {
      if (!lightbox || !resultImage || !resultImage.src) return;
      if (lightboxImage) lightboxImage.src = resultImage.src;
      lightbox.classList.remove("is-hidden");
      lightbox.setAttribute("aria-hidden", "false");
    }

    function closeLightbox() {
      if (!lightbox) return;
      lightbox.classList.add("is-hidden");
      lightbox.setAttribute("aria-hidden", "true");
    }

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

    function setGeneratingState(nextIsGenerating) {
      isGenerating = nextIsGenerating;
      if (generateButton) {
        generateButton.disabled = nextIsGenerating || !selectedPersonImageDataUri;
      }
      if (openButton) openButton.disabled = nextIsGenerating;
    }

    function startProgressAnimation() {
      stopProgressAnimation();
      currentProgressPercent = 10;
      updateProgressUI(currentProgressPercent);

      progressInterval = setInterval(function () {
        if (currentProgressPercent < 90) {
          var step = currentProgressPercent < 50 ? 4 : (currentProgressPercent < 75 ? 2 : 1);
          currentProgressPercent += step;
          updateProgressUI(currentProgressPercent);
        }
      }, 350);
    }

    function stopProgressAnimation() {
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
    }

    function updateProgressUI(percent) {
      if (progressFill) progressFill.style.width = percent + "%";
      if (progressText) progressText.textContent = percent + "%";
    }

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
              reject(new Error("Could not process image."));
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

    async function handleSelectedFile(file) {
      hideError();
      var validationError = validateImageFile(file);
      if (validationError) {
        showError(validationError);
        return;
      }

      try {
        selectedPersonImageDataUri = await compressImageFile(file);
        try {
          localStorage.setItem("vto_saved_user_photo", selectedPersonImageDataUri);
        } catch (e) {}

        if (customerPhotoImage) customerPhotoImage.src = selectedPersonImageDataUri;
        if (loadingUserImage) loadingUserImage.src = selectedPersonImageDataUri;
        if (photoUploadPrompt) photoUploadPrompt.classList.add("is-hidden");
        if (customerPhotoPreview) customerPhotoPreview.classList.remove("is-hidden");
        if (photoDropzone) photoDropzone.classList.add("has-preview");
        if (generateButton) generateButton.disabled = false;
      } catch (err) {
        selectedPersonImageDataUri = null;
        showError(err.message || "Failed to process photo.");
      }
    }

    async function pollForJobResult(requestId) {
      setGeneratingState(true);
      showStep(stepLoading);
      startProgressAnimation();
      activeAbortController = new AbortController();

      var startTime = Date.now();
      var maxWaitMs = 300000; // 5 minutes max wait
      var pollDelayMs = 3500;

      try {
        while (Date.now() - startTime < maxWaitMs) {
          await new Promise(function (resolve) { setTimeout(resolve, pollDelayMs); });

          if (!activeAbortController || activeAbortController.signal.aborted) {
            return;
          }

          if (pollDelayMs < 5000) {
            pollDelayMs = Math.min(5000, pollDelayMs + 500);
          }

          var pollResponse = await fetch(APP_PROXY_TRY_ON_PATH, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ checkStatus: true, requestId: requestId }),
            signal: activeAbortController.signal,
          });

          if (!pollResponse.ok) continue;

          var pollData = await pollResponse.json().catch(function () { return {}; });
          var finalTryOnUrl = pollData.tryOnImage || pollData.imageUri;

          if (pollData.success && pollData.status === "completed" && finalTryOnUrl) {
            stopProgressAnimation();
            updateProgressUI(100);

            try {
              localStorage.removeItem("vto_active_job_" + productId);
              localStorage.setItem("vto_cached_result_" + productId, JSON.stringify({ url: finalTryOnUrl, time: Date.now() }));
            } catch (e) {}

            setTimeout(function () {
              if (resultImage) resultImage.src = finalTryOnUrl;
              showStep(stepResult);
            }, 300);
            return;
          }

          if (pollData.status === "failed") {
            try { localStorage.removeItem("vto_active_job_" + productId); } catch (e) {}
            stopProgressAnimation();
            showStep(stepUpload);
            showError(pollData.error || "Virtual Try-On generation failed. Please try again.");
            return;
          }
        }

        try { localStorage.removeItem("vto_active_job_" + productId); } catch (e) {}
        stopProgressAnimation();
        showStep(stepUpload);
        showError("Virtual Try-On request timed out. Please try again.");
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
              ? "Virtual Try-On App Proxy is not reachable."
              : "Server response error. Please try again."
          );
          return;
        }

        var data = await response.json();

        // 1. Direct synchronous success
        if (response.ok && data.success && data.tryOnImage) {
          stopProgressAnimation();
          updateProgressUI(100);

          try {
            localStorage.setItem("vto_cached_result_" + productId, JSON.stringify({ url: data.tryOnImage, time: Date.now() }));
          } catch (e) {}

          setTimeout(function () {
            if (resultImage) resultImage.src = data.tryOnImage;
            showStep(stepResult);
          }, 300);
          return;
        }

        // 2. Asynchronous job queued — Save active job in localStorage for page reload persistence
        if (response.ok && data.success && (data.requestId || data.status === "processing")) {
          var requestId = data.requestId;
          try {
            localStorage.setItem("vto_active_job_" + productId, JSON.stringify({ requestId: requestId, timestamp: Date.now() }));
          } catch (e) {}

          await pollForJobResult(requestId);
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

    function checkAndRestoreActiveState() {
      try {
        // 1. Auto-restore saved customer photo if available
        var savedUserPhoto = localStorage.getItem("vto_saved_user_photo");
        if (savedUserPhoto && !selectedPersonImageDataUri) {
          selectedPersonImageDataUri = savedUserPhoto;
          if (customerPhotoImage) customerPhotoImage.src = selectedPersonImageDataUri;
          if (loadingUserImage) loadingUserImage.src = selectedPersonImageDataUri;
          if (photoUploadPrompt) photoUploadPrompt.classList.add("is-hidden");
          if (customerPhotoPreview) customerPhotoPreview.classList.remove("is-hidden");
          if (photoDropzone) photoDropzone.classList.add("has-preview");
          if (generateButton) generateButton.disabled = false;
        }

        // 2. Auto-resume active job if page was reloaded while processing (< 5 minutes old)
        var rawJob = localStorage.getItem("vto_active_job_" + productId);
        if (rawJob) {
          var job = JSON.parse(rawJob);
          var age = Date.now() - (job.timestamp || 0);
          if (job.requestId && age < 300000) {
            openModal();
            pollForJobResult(job.requestId);
            return;
          } else {
            localStorage.removeItem("vto_active_job_" + productId);
          }
        }

        // 3. Restore cached result if available (< 1 hour old)
        var rawCachedResult = localStorage.getItem("vto_cached_result_" + productId);
        if (rawCachedResult) {
          var cached = JSON.parse(rawCachedResult);
          if (cached.url && (Date.now() - cached.time < 3600000)) {
            if (resultImage) resultImage.src = cached.url;
          }
        }
      } catch (e) {
        console.warn("[VirtualTryOn] Active state restore notice:", e);
      }
    }

    // Event Attachments
    on(openButton, "click", function (e) {
      e.preventDefault();
      openModal();
    });

    on(sideTab, "click", function (e) {
      e.preventDefault();
      openModal();
    });

    on(closeButton, "click", closeModal);
    on(backdrop, "click", closeModal);

    on(expandButton, "click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      openLightbox();
    });
    on(lightboxCloseBtn, "click", closeLightbox);
    if (lightbox) {
      on(lightbox, "click", function (e) {
        if (e.target === lightbox) closeLightbox();
      });
    }

    on(document, "keydown", function (e) {
      if (e.key === "Escape" || e.keyCode === 27) {
        if (lightbox && !lightbox.classList.contains("is-hidden")) {
          closeLightbox();
        } else if (modal && !modal.classList.contains("is-hidden")) {
          closeModal();
        }
      }
    });

    on(photoFileInput, "change", function (e) {
      var files = e.target && e.target.files;
      if (files && files[0]) handleSelectedFile(files[0]);
    });

    on(changePhotoButton, "click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      try { localStorage.removeItem("vto_saved_user_photo"); } catch (err) {}
      resetUploadState();
      if (photoFileInput) photoFileInput.click();
    });

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

    on(generateButton, "click", function () {
      generateTryOn();
    });

    on(retryButton, "click", function () {
      stopProgressAnimation();
      showStep(stepUpload);
    });

    // Check active job or saved state on page load
    checkAndRestoreActiveState();

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

  function normalizeVariantId(rawVariantId) {
    if (!rawVariantId) return "";
    var value = String(rawVariantId).trim();
    var gidMatch = value.match(/ProductVariant\/(\d+)/);
    if (gidMatch) return gidMatch[1];
    if (/^\d+$/.test(value)) return value;
    return value;
  }

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
