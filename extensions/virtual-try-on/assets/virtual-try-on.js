(function () {
  "use strict";

  function initVirtualTryOn() {
    console.log("[VTO Client] Initializing Virtual Try-On widget...");

    const wrapper = document.querySelector(".vto-block-wrapper");
    if (!wrapper) {
      console.warn("[VTO Client] Block wrapper .vto-block-wrapper not found.");
      return;
    }

    const productId = wrapper.dataset.productId;
    const variantId = wrapper.dataset.variantId;
    const garmentUrl = wrapper.dataset.garmentUrl;

    console.log("[VTO Client] Config extracted:", { productId, variantId, garmentUrl });

    const modal = document.getElementById("vto-modal");
    if (!modal) {
      console.warn("[VTO Client] Modal #vto-modal element not found.");
      return;
    }

    // Move modal to body to prevent theme container clipping
    if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }

    const backdrop = document.getElementById("vto-backdrop");
    const closeBtn = document.getElementById("vto-close-btn");

    const stepUpload = document.getElementById("vto-step-upload");
    const stepLoading = document.getElementById("vto-step-loading");
    const stepResult = document.getElementById("vto-step-result");

    const dropzone = document.getElementById("vto-dropzone");
    const fileInput = document.getElementById("vto-file-input");
    const uploadPlaceholder = document.getElementById("vto-upload-placeholder");
    const userPreviewBox = document.getElementById("vto-user-preview-box");
    const userPreviewImg = document.getElementById("vto-user-preview-img");
    const changePhotoBtn = document.getElementById("vto-change-photo-btn");
    const errorBanner = document.getElementById("vto-error-banner");
    const generateBtn = document.getElementById("vto-generate-btn");

    const resultImg = document.getElementById("vto-result-img");
    const retryBtn = document.getElementById("vto-retry-btn");
    const cartBtn = document.getElementById("vto-cart-btn");

    let selectedBase64 = null;

    // Helper: Show specific step
    function showStep(stepElement) {
      [stepUpload, stepLoading, stepResult].forEach((el) => {
        if (el) el.classList.add("vto-hidden");
      });
      if (stepElement) stepElement.classList.remove("vto-hidden");
    }

    // Helper: Show Error
    function showError(msg) {
      console.error("[VTO Client Error]", msg);
      if (errorBanner) {
        errorBanner.textContent = msg;
        errorBanner.classList.remove("vto-hidden");
      }
    }

    // Helper: Hide Error
    function hideError() {
      if (errorBanner) {
        errorBanner.textContent = "";
        errorBanner.classList.add("vto-hidden");
      }
    }

    // Modal Visibility
    function openModal() {
      console.log("[VTO Client] Opening Virtual Try-On modal");
      if (modal) {
        modal.classList.remove("vto-hidden");
        modal.setAttribute("aria-hidden", "false");
        showStep(stepUpload);
      }
    }

    function closeModal() {
      console.log("[VTO Client] Closing Virtual Try-On modal");
      if (modal) {
        modal.classList.add("vto-hidden");
        modal.setAttribute("aria-hidden", "true");
      }
    }

    // Attach click listener directly on trigger button
    const openTrigger = wrapper.querySelector(".vto-trigger-btn") || document.getElementById("vto-open-trigger");
    if (openTrigger) {
      openTrigger.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        openModal();
      };
    }

    if (backdrop) backdrop.onclick = closeModal;
    if (closeBtn) closeBtn.onclick = closeModal;

    // Reset upload form UI
    function resetUploadState() {
      selectedBase64 = null;
      if (fileInput) fileInput.value = "";
      if (userPreviewImg) userPreviewImg.src = "";
      if (uploadPlaceholder) uploadPlaceholder.classList.remove("vto-hidden");
      if (userPreviewBox) userPreviewBox.classList.add("vto-hidden");
      if (dropzone) dropzone.classList.remove("vto-has-preview");
      if (generateBtn) generateBtn.disabled = true;
      hideError();
    }

    // File Validation & Handling
    function handleFile(file) {
      hideError();

      if (!file) return;

      console.log("[VTO Client] File selected:", file.name, file.size, file.type);

      const fileName = file.name || "";
      const fileExt = fileName.substring(fileName.lastIndexOf(".")).toLowerCase();
      const validExts = [".jpg", ".jpeg", ".png", ".webp"];
      const isTypeValid = file.type ? file.type.startsWith("image/") : validExts.includes(fileExt);

      if (!isTypeValid && !validExts.includes(fileExt)) {
        showError("Please upload a valid JPG or PNG image.");
        return;
      }

      // 7MB limit
      if (file.size > 7340032) {
        showError("Image size is too large. Please upload an image under 7MB.");
        return;
      }

      const reader = new FileReader();
      reader.onerror = function (err) {
        console.error("[VTO Client] FileReader error:", err);
        showError("Failed to read image file. Please try selecting a different image.");
      };
      reader.onload = function (e) {
        selectedBase64 = e.target.result;
        console.log("[VTO Client] File converted to Base64 (length: " + selectedBase64.length + ")");
        if (userPreviewImg) {
          userPreviewImg.src = selectedBase64;
        }
        if (uploadPlaceholder) uploadPlaceholder.classList.add("vto-hidden");
        if (userPreviewBox) userPreviewBox.classList.remove("vto-hidden");
        if (dropzone) dropzone.classList.add("vto-has-preview");
        if (generateBtn) generateBtn.disabled = false;
      };
      reader.readAsDataURL(file);
    }

    if (fileInput) {
      fileInput.onchange = function (e) {
        if (e.target.files && e.target.files[0]) {
          handleFile(e.target.files[0]);
        }
      };
    }

    if (changePhotoBtn) {
      changePhotoBtn.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        resetUploadState();
        if (fileInput) fileInput.click();
      };
    }

    // Drag and drop handlers
    if (dropzone) {
      ["dragenter", "dragover"].forEach((eventName) => {
        dropzone.addEventListener(
          eventName,
          (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add("vto-dragover");
          },
          false
        );
      });

      ["dragleave", "drop"].forEach((eventName) => {
        dropzone.addEventListener(
          eventName,
          (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove("vto-dragover");
          },
          false
        );
      });

      dropzone.addEventListener("drop", (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files && files[0]) {
          handleFile(files[0]);
        }
      });
    }

    // Generate Action
    if (generateBtn) {
      generateBtn.onclick = async function () {
        if (!selectedBase64) {
          showError("Please upload a photo first.");
          return;
        }

        hideError();
        showStep(stepLoading);

        console.log("[VTO Client] Submitting Virtual Try-On request to server...");

        try {
          const payload = JSON.stringify({
            personImage: selectedBase64,
            garmentImageUrl: garmentUrl,
            productId: productId,
            variantId: variantId,
          });

          // App Proxy: storefront /apps/virtual-try-on → app /api/virtual-try-on
          // Do NOT fall back to /api/virtual-try-on on the storefront domain (always 404).
          const apiUrl = "/apps/virtual-try-on";
          console.log("[VTO Client] Fetching from endpoint:", apiUrl);

          const response = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
          });

          console.log("[VTO Client] Server response status:", response.status, response.statusText);

          let data;
          const contentType = response.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            data = await response.json();
          } else {
            const rawText = await response.text();
            console.error("[VTO Client] Non-JSON response received:", rawText.substring(0, 300));
            showStep(stepUpload);
            showError(
              response.status === 404
                ? "Virtual Try-On app proxy is not configured. Redeploy the app or run shopify app dev."
                : `Server HTTP ${response.status} Error. Please check backend server console.`
            );
            return;
          }

          console.log("[VTO Client] Server JSON payload:", data);

          if (response.ok && data.success && data.tryOnImage) {
            console.log("[VTO Client] Try-On image generated successfully!");
            if (resultImg) resultImg.src = data.tryOnImage;
            showStep(stepResult);
          } else {
            showStep(stepUpload);
            showError(data.error || "Failed to generate try-on result. Please try again.");
          }
        } catch (err) {
          console.error("[VTO Client Exception]:", err);
          showStep(stepUpload);
          showError("Connection error: " + err.message);
        }
      };
    }

    // Retry Action
    if (retryBtn) {
      retryBtn.onclick = function () {
        showStep(stepUpload);
      };
    }

    // Add to Cart Action
    if (cartBtn) {
      cartBtn.onclick = async function () {
        cartBtn.disabled = true;
        cartBtn.textContent = "Adding...";

        try {
          const res = await fetch("/cart/add.js", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              items: [
                {
                  id: parseInt(variantId, 10) || variantId,
                  quantity: 1,
                },
              ],
            }),
          });

          if (res.ok) {
            cartBtn.textContent = "Added to Cart!";
            setTimeout(() => {
              window.location.href = "/cart";
            }, 500);
          } else {
            window.location.href = `/cart/add?id=${variantId}&quantity=1`;
          }
        } catch (e) {
          window.location.href = `/cart/add?id=${variantId}&quantity=1`;
        }
      };
    }
  }

  // Global Fallback Click Listener for modal trigger
  document.addEventListener("click", function (e) {
    const trigger = e.target.closest("#vto-open-trigger") || e.target.closest(".vto-trigger-btn");
    if (trigger) {
      e.preventDefault();
      const modal = document.getElementById("vto-modal");
      if (modal) {
        if (modal.parentElement !== document.body) {
          document.body.appendChild(modal);
        }
        modal.classList.remove("vto-hidden");
        modal.setAttribute("aria-hidden", "false");
        const stepUpload = document.getElementById("vto-step-upload");
        if (stepUpload) stepUpload.classList.remove("vto-hidden");
      }
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initVirtualTryOn);
  } else {
    initVirtualTryOn();
  }

  document.addEventListener("shopify:section:load", initVirtualTryOn);
})();
