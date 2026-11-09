cmake_minimum_required(VERSION 3.24)
project(octant_windows_desktop_qa LANGUAGES CXX)
if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "Native Windows MSVC is required")
endif()
# Reuse the existing suspended, copied-token, kill-on-close owned-job fixture.
# This executable is QA-only and never enters the portable archive.
add_executable(octant-windows-desktop-owner ../windows-host-owner/reader.cpp)
target_compile_features(octant-windows-desktop-owner PRIVATE cxx_std_17)
target_compile_definitions(octant-windows-desktop-owner PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
set_property(TARGET octant-windows-desktop-owner PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
target_compile_options(octant-windows-desktop-owner PRIVATE /W4 /WX /EHsc /utf-8)
target_link_libraries(octant-windows-desktop-owner PRIVATE advapi32)
