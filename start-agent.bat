@echo off
setlocal

cd /d "%~dp0"

echo Realestate agent baslatiliyor...
echo.

where pnpm >nul 2>nul
if errorlevel 1 (
  echo HATA: pnpm bulunamadi.
  echo Once su komutu calistirin:
  echo npm install -g pnpm
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Bagimliliklar bulunamadi, pnpm install calistiriliyor...
  call pnpm install
  if errorlevel 1 (
    echo.
    echo HATA: pnpm install basarisiz oldu.
    pause
    exit /b 1
  )
)

echo Bot baslatiliyor: pnpm dev
echo Kapatmak icin bu pencereyi kapatabilir veya Ctrl+C kullanabilirsiniz.
echo.

call pnpm dev

echo.
echo Islem tamamlandi.
pause
